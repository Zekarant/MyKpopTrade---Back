import type { NextFunction, Request, Response } from 'express';
import passport from 'passport';
import env from '../../../../config/env';
import * as oauthLoginService from '../../services/oauthLoginService';
import { googleCallback, discordCallback, facebookCallback } from '../socialAuthController';

jest.mock('../../services/oauthLoginService', () => ({
  ...jest.requireActual('../../services/oauthLoginService'),
  completeOAuthLogin: jest.fn(),
  linkUserIdFromState: jest.fn()
}));

/** Retours des fournisseurs OAuth : chaque issue redirige vers la bonne page du front. */
const FRONT = 'http://front.test';
env.FRONTEND_URL = FRONT;

const completeOAuthLogin = jest.mocked(oauthLoginService.completeOAuthLogin);
const linkUserIdFromState = jest.mocked(oauthLoginService.linkUserIdFromState);

type StrategyOutcome = { err?: Error | null; user?: object | false; info?: Record<string, unknown> };

/** Simule la fin de la stratégie passport : le contrôleur reçoit (err, user, info). */
function strategyEndsWith({ err = null, user = false, info }: StrategyOutcome) {
  jest.spyOn(passport, 'authenticate').mockImplementation(((_strategy: string, _options: object, callback: (...args: unknown[]) => void) =>
    () => callback(err, user, info)) as unknown as typeof passport.authenticate);
}

async function run(callback: (req: Request, res: Response, next: NextFunction) => void) {
  const req = { query: {} } as Request;
  const redirect = jest.fn();
  const next = jest.fn();
  callback(req, { redirect } as unknown as Response, next);
  // oauthCallback est asynchrone : laisser ses promesses se résoudre.
  await new Promise(setImmediate);
  return { redirectedTo: redirect.mock.calls[0]?.[0] as string | undefined, next };
}

const user = { _id: 'u1', username: 'jeanne' };

describe('socialAuthController — retours OAuth', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    completeOAuthLogin.mockReset();
    linkUserIdFromState.mockReset().mockReturnValue(undefined);
  });

  describe('googleCallback', () => {
    it('renvoie vers /login avec le motif du refus', async () => {
      strategyEndsWith({ info: { message: 'account_suspended' } });

      expect((await run(googleCallback)).redirectedTo).toBe(`${FRONT}/login?error=account_suspended`);
    });

    it('renvoie vers les paramètres quand une liaison échoue', async () => {
      linkUserIdFromState.mockReturnValue('u1');
      strategyEndsWith({});

      expect((await run(googleCallback)).redirectedTo).toBe(`${FRONT}/settings?error=google_link_failed`);
    });

    it('confirme une liaison réussie sans ouvrir de session', async () => {
      strategyEndsWith({ user, info: { isLink: true } });

      expect((await run(googleCallback)).redirectedTo).toBe(`${FRONT}/settings?linked=google`);
      expect(completeOAuthLogin).not.toHaveBeenCalled();
    });

    it('transmet un code à usage unique et signale un nouveau compte', async () => {
      strategyEndsWith({ user, info: { isNew: true } });
      completeOAuthLogin.mockResolvedValue({ requiresTwoFactor: false, code: 'CODE', requiresProfileCompletion: true });

      expect((await run(googleCallback)).redirectedTo)
        .toBe(`${FRONT}/auth/callback?code=CODE&newAccount=1&completeProfile=1`);
    });

    it('demande le second facteur quand la 2FA est active', async () => {
      strategyEndsWith({ user });
      completeOAuthLogin.mockResolvedValue({ requiresTwoFactor: true, twoFactorToken: 'DEFI' });

      expect((await run(googleCallback)).redirectedTo).toBe(`${FRONT}/login?twoFactorToken=DEFI`);
    });

    it('renvoie vers /login?error=server_error si la fin de connexion échoue', async () => {
      strategyEndsWith({ user });
      completeOAuthLogin.mockRejectedValue(new Error('Mongo indisponible'));

      expect((await run(googleCallback)).redirectedTo).toBe(`${FRONT}/login?error=server_error`);
    });
  });

  describe('discordCallback', () => {
    it('encode le motif d\'échec dans l\'URL de /login', async () => {
      strategyEndsWith({ info: { message: 'email non vérifié' } });

      expect((await run(discordCallback)).redirectedTo).toBe(`${FRONT}/login?error=email%20non%20v%C3%A9rifi%C3%A9`);
    });

    it('traite tout retour avec un utilisateur à lier comme une liaison', async () => {
      linkUserIdFromState.mockReturnValue('u1');
      strategyEndsWith({ user });

      expect((await run(discordCallback)).redirectedTo).toBe(`${FRONT}/settings?linked=discord`);
      expect(completeOAuthLogin).not.toHaveBeenCalled();
    });
  });

  describe('facebookCallback', () => {
    it('renvoie vers /login?error=facebook en cas d\'échec', async () => {
      strategyEndsWith({ err: new Error('refus') });

      expect((await run(facebookCallback)).redirectedTo).toBe(`${FRONT}/login?error=facebook`);
    });

    it('ouvre la connexion par code en cas de succès', async () => {
      strategyEndsWith({ user });
      completeOAuthLogin.mockResolvedValue({ requiresTwoFactor: false, code: 'CODE', requiresProfileCompletion: false });

      expect((await run(facebookCallback)).redirectedTo).toBe(`${FRONT}/auth/callback?code=CODE`);
    });
  });
});
