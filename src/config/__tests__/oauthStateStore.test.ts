import express from 'express';
import passport from 'passport';
import request from 'supertest';
import { OAuth2 } from 'oauth';
import { Strategy as OAuth2Strategy, StateStore, VerifyCallback } from 'passport-oauth2';
import { CookieStateStore, OAUTH_STATE_COOKIE, OAuthAppState, readOAuthState } from '../oauthStateStore';

type TokenCallback = (err: null, accessToken: string, refreshToken: string, results: object) => void;

/** Stratégie de test : simule l'échange du code d'autorisation, sans réseau. */
class TestOAuth2Strategy extends OAuth2Strategy {
  stubTokenExchange(): void {
    this._oauth2.getOAuthAccessToken = ((_code: string, _params: unknown, cb: TokenCallback) =>
      cb(null, 'access', 'refresh', {})) as OAuth2['getOAuthAccessToken'];
  }
}

/** Parcours via passport-oauth2, sans réseau : échange du code et profil simulés. */
function buildApp() {
  const authenticator = new passport.Passport();
  const strategy = new TestOAuth2Strategy(
    {
      authorizationURL: 'https://fournisseur.test/authorize',
      tokenURL: 'https://fournisseur.test/token',
      clientID: 'client',
      clientSecret: 'secret',
      callbackURL: 'http://api.test/api/auth/test/callback',
      store: new CookieStateStore() as StateStore
    },
    (_accessToken: string, _refreshToken: string, profile: Express.User, done: VerifyCallback) =>
      done(null, profile)
  );
  strategy.stubTokenExchange();
  strategy.userProfile = (_accessToken, done) => done(null, { id: 'profil-1' });
  authenticator.use('test', strategy);

  const linkState: OAuthAppState = { linkToken: 'jeton-liaison' };
  const app = express();
  app.use(authenticator.initialize());
  app.get('/api/auth/test', authenticator.authenticate('test', { session: false }));
  app.get('/api/auth/test/link', (req, res, next) =>
    // passport type `state` en chaîne ; passport-oauth2 n'utilise le magasin que pour un objet.
    authenticator.authenticate('test', { session: false, state: linkState as unknown as string })(req, res, next)
  );
  app.get('/api/auth/test/callback', (req, res, next) =>
    authenticator.authenticate('test', { session: false }, (err: unknown, user?: Express.User | false, info?: object) => {
      if (err) return next(err);
      res.json({ user: user || null, info: info ?? null });
    })(req, res, next)
  );
  return app;
}

/** Lance un parcours et rend le state envoyé au fournisseur et le cookie posé. */
async function startFlow(app: express.Express, path = '/api/auth/test') {
  const res = await request(app).get(path);
  const location = new URL(res.headers.location);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const stateCookie = setCookie.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!;
  return {
    res,
    state: location.searchParams.get('state')!,
    setCookie: stateCookie,
    cookie: stateCookie.split(';')[0]
  };
}

describe('CookieStateStore', () => {
  const app = buildApp();

  it('pose un cookie HttpOnly, SameSite=Lax, limité aux routes OAuth', async () => {
    const { res, state, setCookie } = await startFlow(app);

    expect(res.status).toBe(302);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/);
    expect(setCookie).toContain(`${OAUTH_STATE_COOKIE}=${readOAuthState(state)!.nonce}`);
  });

  it('accepte le retour du fournisseur dans le navigateur qui a lancé le parcours', async () => {
    const { state, cookie } = await startFlow(app);

    const res = await request(app)
      .get('/api/auth/test/callback')
      .query({ code: 'code-autorisation', state })
      .set('Cookie', cookie);

    expect(res.body.user).toEqual({ id: 'profil-1' });
  });

  it('transmet le jeton de liaison porté par le state', async () => {
    const { state, cookie } = await startFlow(app, '/api/auth/test/link');

    expect(readOAuthState(state)!.linkToken).toBe('jeton-liaison');
    const res = await request(app)
      .get('/api/auth/test/callback')
      .query({ code: 'code-autorisation', state })
      .set('Cookie', cookie);

    expect(res.body.info.state).toEqual({ linkToken: 'jeton-liaison' });
  });

  it('refuse un retour sans cookie : parcours lancé ailleurs (CSRF)', async () => {
    const { state } = await startFlow(app);

    const res = await request(app)
      .get('/api/auth/test/callback')
      .query({ code: 'code-de-l-attaquant', state });

    expect(res.body.user).toBeNull();
    expect(res.body.info).toEqual({ message: 'oauth_state_invalid' });
  });

  it('refuse le state d\'un autre parcours', async () => {
    const attacker = await startFlow(app);
    const victim = await startFlow(app);

    const res = await request(app)
      .get('/api/auth/test/callback')
      .query({ code: 'code-de-l-attaquant', state: attacker.state })
      .set('Cookie', victim.cookie);

    expect(res.body.info).toEqual({ message: 'oauth_state_invalid' });
  });

  it('refuse un state illisible', async () => {
    const { cookie } = await startFlow(app);

    const res = await request(app)
      .get('/api/auth/test/callback')
      .query({ code: 'code', state: '{"linkToken":"x"}' })
      .set('Cookie', cookie);

    expect(res.body.info).toEqual({ message: 'oauth_state_invalid' });
  });

  it('efface le cookie au retour : il ne sert qu\'une fois', async () => {
    const { state, cookie } = await startFlow(app);

    const res = await request(app)
      .get('/api/auth/test/callback')
      .query({ code: 'code-autorisation', state })
      .set('Cookie', cookie);

    const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cleared.some((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=;`) && /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
  });
});
