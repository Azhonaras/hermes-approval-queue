/**
 * Signs in to a TEST WordPress site the way a browser does and prints what a reviewer request needs:
 * the session cookies and the REST nonce (WordPress's CSRF token for cookie-authenticated REST calls).
 *
 *   node login.mjs <siteUrl> <user> <password>          prints {"cookie":"...","nonce":"..."}
 *
 * Works where Application Passwords do not (for example WordPress Playground over plain http).
 * Test sites only: the password is passed on the command line.
 */
export async function login(siteUrl, user, password) {
  const site = siteUrl.replace(/\/$/, '');
  const jar = new Map([['wordpress_test_cookie', 'WP%20Cookie%20check']]);
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '' || value === 'deleted' || /expires=Thu, 01[- ]Jan[- ]1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  };

  const form = new URLSearchParams({ log: user, pwd: password, 'wp-submit': 'Log In', testcookie: '1', redirect_to: site + '/wp-admin/' });
  const res = await fetch(site + '/wp-login.php', {
    method: 'POST', redirect: 'manual', body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() }
  });
  keep(res);
  if (![...jar.keys()].some((k) => k.startsWith('wordpress_logged_in_'))) {
    throw new Error(`login as ${user} failed (HTTP ${res.status}); check the user name and password`);
  }
  const nonceRes = await fetch(site + '/wp-admin/admin-ajax.php?action=rest-nonce', { headers: { Cookie: cookieHeader() } });
  const nonce = (await nonceRes.text()).trim();
  if (!/^[0-9a-f]{10}$/.test(nonce)) throw new Error(`no REST nonce for ${user} (HTTP ${nonceRes.status}: ${nonce.slice(0, 80)})`);
  jar.delete('wordpress_test_cookie');
  return { cookie: cookieHeader(), nonce };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('login.mjs')) {
  const [site, user, password] = process.argv.slice(2);
  if (!site || !user || !password) {
    console.error('usage: node login.mjs <siteUrl> <user> <password>');
    process.exit(2);
  }
  login(site, user, password).then((r) => console.log(JSON.stringify(r)), (e) => { console.error(e.message); process.exit(1); });
}
