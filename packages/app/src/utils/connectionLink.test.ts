import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConnectionLink, resolveConnectionLink } from './connectionLink'

const redeem = vi.hoisted(() => vi.fn())
vi.mock('../omp/transport', () => ({ redeemPairCode: redeem }))

describe('connectionLink', () => {
  beforeEach(() => redeem.mockReset())

  it.each([
    'http://100.101.2.3:8787/?pair=once.secret',
    '等待手机连接 · http://100.101.2.3:8787/?pair=once.secret',
    '[http://100.101.2.3:8787/?pair=once.secret](http://100.101.2.3:8787/?pair=once.secret)',
    '配对链接：http://100.101.2.3:8787/?pair=once.secret。请连接',
  ])('extracts a pairing link from copied information: %s', input => {
    expect(parseConnectionLink(input)).toEqual({ url: 'http://100.101.2.3:8787', pair: 'once.secret' })
  })

  it('supports IPv6 pairing addresses', () => {
    expect(parseConnectionLink('http://[fd7a:115c:a1e0::1]:8787/?pair=once.secret')).toEqual({
      url: 'http://[fd7a:115c:a1e0::1]:8787', pair: 'once.secret',
    })
  })

  it.each(['ompiui', 'piui'])('preserves %s connection shares', async scheme => {
    const link = parseConnectionLink(`${scheme}://connect?url=https%3A%2F%2Fremote.test&token=share-token`)!
    expect(await resolveConnectionLink(link)).toEqual({ url: 'https://remote.test', token: 'share-token' })
    expect(redeem).not.toHaveBeenCalled()
  })

  it('preserves a reverse proxy base path when redeeming', async () => {
    redeem.mockResolvedValue({ url: 'https://relay.test/backend', token: 'server-token' })
    const link = parseConnectionLink('https://relay.test/backend/?pair=once.secret')!
    expect(await resolveConnectionLink(link)).toEqual({ url: 'https://relay.test/backend', token: 'server-token' })
    expect(redeem).toHaveBeenCalledWith('once.secret', 'https://relay.test/backend', expect.any(AbortSignal))
  })

  it.each([
    'not a link',
    'http://remote.test',
    'http://remote.test/?pair=',
    'http://user:password@remote.test/?pair=once.secret',
    'ompiui://connect?url=file%3A%2F%2F%2Ftmp%2Fsecret&token=share-token',
  ])('rejects information without valid remote credentials: %s', input => {
    expect(parseConnectionLink(input)).toBeNull()
  })
})
