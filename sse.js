/**
 * SSE 解码：把网关的 OpenAI Chat SSE 转成 harness 的 StreamChunk 序列。
 *
 * 内核的 stream invariant 会逐块校验，规则是：
 *   - 每个块先 `block-start`，delta 只能落在**已打开**的同类块上；
 *   - `block-end` 的 `block.type` 必须与打开时一致，且要带**完整内容**
 *     （文本块带累计文本，工具块带 id / name / 累计 arguments 字符串）；
 *   - `finish` 之后不能再有 chunk；`usage` 最多一次。
 *
 * 因此这里必须自己累积：网关只发增量，而内核要的是成品。
 *
 * @module sse
 */

/** 一条 SSE 数据行是否可解析。 */
function parseFrame(payload) {
  try { return JSON.parse(payload) } catch { return undefined }
}

/**
 * 把一条 OpenAI Chat SSE 流读成 StreamChunk。
 *
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator<object>}
 */
export async function* decodeChatSse(response, signal) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  /** 打开的块：index -> { kind, text, id, name, args } */
  const blocks = new Map()
  /** 网关的 tool_calls[].index -> 我们分配的块 index */
  const toolSlots = new Map()
  let nextIndex = 0
  let buffer = ''
  let finishReason = ''
  let usage

  /** 开一个新块并返回它的 block-start。 */
  const open = (kind, extra = {}) => {
    const index = nextIndex++
    const block = { kind, text: '', id: '', name: '', args: '', ...extra }
    blocks.set(index, block)
    return { chunk: { type: 'block-start', index, blockType: kind }, block }
  }

  /** 找第一个指定类型的已打开块。 */
  const findKind = kind => {
    for (const [index, block] of blocks) if (block.kind === kind) return { index, block }
    return undefined
  }

  /**
   * 让 abort 能**立即**打断正在等待的 `reader.read()`。
   *
   * 只在循环顶部检查 `signal.aborted` 是不够的：模型「想很久但一个字节都不发」
   * 时，执行流卡在 `await reader.read()` 里，abort 要等到下一个数据块到达才会
   * 被看见——而重思考模型的下一个数据块可能在 9 秒之后。首字超时因此形同虚设
   * （实测：设 1ms 上限，请求仍然等了 1.8 秒才正常返回）。
   *
   * 所以把 `read()` 与一个「abort 即拒绝」的 promise 赛跑：谁先完成谁说了算。
   * 中止后 `finally` 里的 `reader.cancel()` 会释放底层连接。
   */
  let onAbort = null
  const abortSignal = signal === undefined || signal === null ? null : new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
    if (signal.aborted === true) { fail(); return }
    onAbort = fail
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    while (true) {
      if (signal?.aborted === true) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      // 用 `abortSignal` 包一层：即使此刻没有新数据到达，abort 也能立刻结束等待。
      const row = abortSignal === null ? await reader.read() : await Promise.race([reader.read(), abortSignal])
      if (row.done) break
      buffer += decoder.decode(row.value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        const frame = parseFrame(payload)
        if (frame === undefined) continue
        if (frame?.usage !== undefined && frame.usage !== null) usage = frame.usage
        const choice = Array.isArray(frame?.choices) ? frame.choices[0] : undefined
        if (choice === undefined) continue
        const delta = choice.delta ?? {}

        // ── 思考增量 ──
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning !== '') {
          let slot = findKind('reasoning')
          if (slot === undefined) {
            const created = open('reasoning')
            yield created.chunk
            slot = { index: nextIndex - 1, block: created.block }
          }
          slot.block.text += reasoning
          yield { type: 'reasoning-delta', index: slot.index, text: reasoning }
        }

        // ── 正文增量 ──
        if (typeof delta.content === 'string' && delta.content !== '') {
          let slot = findKind('text')
          if (slot === undefined) {
            const created = open('text')
            yield created.chunk
            slot = { index: nextIndex - 1, block: created.block }
          }
          slot.block.text += delta.content
          yield { type: 'text-delta', index: slot.index, text: delta.content }
        }

        // ── 工具调用增量 ──
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const key = Number.isInteger(call?.index) ? call.index : 0
          let index = toolSlots.get(key)
          if (index === undefined) {
            const created = open('tool-call', {
              id: String(call?.id ?? ''),
              name: String(call?.function?.name ?? ''),
            })
            index = nextIndex - 1
            toolSlots.set(key, index)
            yield created.chunk
          }
          const block = blocks.get(index)
          if (typeof call?.id === 'string' && call.id !== '') block.id = call.id
          const name = call?.function?.name
          if (typeof name === 'string' && name !== '') block.name = name
          const args = call?.function?.arguments
          if (typeof args === 'string' && args !== '') {
            block.args += args
            yield { type: 'tool-call-delta', index, id: block.id, argumentsDelta: args }
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
          finishReason = choice.finish_reason
        }
      }
    }
  } finally {
    // 摘掉监听器：调用方可能在同一个 signal 上反复挂载新的解码器。
    if (onAbort !== null && signal !== undefined && signal !== null) {
      try { signal.removeEventListener('abort', onAbort) } catch { /* 老实现没有这个 API */ }
    }
    try { await reader.cancel() } catch { /* already closed */ }
  }

  // ── 关闭所有块，带上成品内容 ──
  for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (block.kind === 'text') {
      yield { type: 'block-end', index, block: { type: 'text', text: block.text } }
    } else if (block.kind === 'reasoning') {
      yield { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
    } else {
      // 参数不完整时补成合法 JSON：内核会按字符串原样透传，但下游解析失败
      // 会让整轮变成不可执行调用，不如在这里就归一成空对象。
      const args = block.args.trim() === '' ? '{}' : block.args
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: block.id, name: block.name, arguments: args },
      }
    }
  }
  blocks.clear()

  if (usage !== undefined) {
    const cached = Number(usage.prompt_tokens_details?.cached_tokens)
    const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens)
    yield {
      type: 'usage',
      usage: {
        inputTokens: Number(usage.prompt_tokens) || 0,
        outputTokens: Number(usage.completion_tokens) || 0,
        ...Number.isFinite(cached) && cached > 0 ? { cacheReadTokens: cached } : {},
        ...Number.isFinite(reasoningTokens) && reasoningTokens > 0 ? { reasoningTokens } : {},
      },
    }
  }

  yield {
    type: 'finish',
    reason: finishReason === 'tool_calls' ? { kind: 'tool-calls' }
      : finishReason === 'length' ? { kind: 'max-tokens' }
        : { kind: 'stop' },
  }
}
