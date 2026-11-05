import { expect, it } from 'vitest'
import { rpc } from './mcp.ts'

it('reports the build it runs as its serverInfo version', async () => {
  const response = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  const { result } = await response.json<{ result: { serverInfo: { name: string; version: string } } }>()
  expect(result.serverInfo).toEqual({ name: 'spacewalk', version: 'main (a1b2c3d)' })
})
