import { FakeNet } from '../testing/fake-net.testing';
import type { HostAddress } from '../hosts/host-normalize';
import { buildInstruction } from './ownership.service';

const host: HostAddress = {
  scheme: 'https',
  host: 'raffle-fe-next.vercel.app',
  port: 443,
};
const url = 'https://raffle-fe-next.vercel.app/';
const token = 'owner-account-proof_12345678';
describe('Vercel exact-host HTTP header ownership', () => {
  it('requires the matching account token on the exact HTTPS origin', async () => {
    const net = new FakeNet().page(url, {
      status: 200,
      headers: { 'x-v4c-verify': token },
    });
    expect(await net.checker().check('header', host, token)).toMatchObject({
      ok: true,
      method: 'header',
    });
    expect(net.asserted).toEqual([url]);
    expect(
      await net.checker().check('header', host, 'other-account'),
    ).toMatchObject({ ok: false, definitive: true });
  });
  it('a neighbour never proves control; removing a token definitively fails', async () => {
    const net = new FakeNet()
      .page('https://neighbour.vercel.app/', {
        status: 200,
        headers: { 'x-v4c-verify': token },
      })
      .page(url, { status: 200 });
    expect(await net.checker().check('header', host, token)).toMatchObject({
      ok: false,
      definitive: true,
    });
  });
  it.each([
    'vercel.app',
    'nested.tenant.vercel.app',
    'example.com',
    'shop.myshopify.com',
  ])('does not expand proof to %s', async (name) => {
    const net = new FakeNet();
    expect(
      (await net.checker().check('header', { ...host, host: name }, token)).ok,
    ).toBe(false);
    expect(net.fetched).toEqual([]);
  });
  it('never follows a redirect to another hostname', async () => {
    const net = new FakeNet().page(url, {
      status: 302,
      location: 'https://neighbour.vercel.app/',
    });
    expect(await net.checker().check('header', host, token)).toMatchObject({
      ok: false,
      code: 'REDIRECT_OTHER_HOST',
    });
    expect(net.fetched).toEqual([url]);
  });
  it('keeps SSRF protection and treats outages as inconclusive', async () => {
    const net = new FakeNet();
    net.privateHosts.add(host.host);
    expect(await net.checker().check('header', host, token)).toMatchObject({
      ok: false,
      code: 'UNSAFE_URL',
      definitive: false,
    });
    const unavailable = new FakeNet().page(url, { status: 503 });
    expect(
      await unavailable.checker().check('header', host, token),
    ).toMatchObject({ ok: false, definitive: false });
  });
  it('instructs verification at the exact root URL without a wildcard', () => {
    expect(buildInstruction('header', host, token)).toEqual({
      method: 'header',
      pageUrl: url,
      name: 'x-v4c-verify',
      value: token,
    });
  });
});
