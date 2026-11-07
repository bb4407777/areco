import assert from 'node:assert/strict'
import test from 'node:test'
import { Pcm16Decoder } from './pcmPlayer'

function pcm16le(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setInt16(index * 2, value, true))
  return bytes
}

test('PCM16LE 任意奇偶 chunk 边界均不漂移', () => {
  const expected = [0, 1, -1, 32767, -32768, 1000, -1000]
  const bytes = pcm16le(expected)
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new Pcm16Decoder()
    const first = decoder.push(bytes.subarray(0, split))
    const second = decoder.push(bytes.subarray(split))
    const actual = [...first, ...second].map((value) => Math.round(value * 32768))
    assert.deepEqual(actual, expected, `split=${split}`)
  }
})

test('PCM16LE 逐字节输入与空块', () => {
  const expected = [1234, -2345]
  const bytes = pcm16le(expected)
  const decoder = new Pcm16Decoder()
  const samples: number[] = []
  for (const byte of bytes) samples.push(...decoder.push(new Uint8Array([byte])))
  samples.push(...decoder.push(new Uint8Array()))
  assert.deepEqual(samples.map((value) => Math.round(value * 32768)), expected)
})
