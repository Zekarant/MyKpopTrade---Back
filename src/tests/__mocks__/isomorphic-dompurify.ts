/**
 * Mock d'isomorphic-dompurify pour les tests Jest.
 * La vraie lib utilise des ESM imports qui ne jouent pas avec le setup
 * CommonJS du projet ; en tests on se contente d'un pass-through.
 */
export default {
  sanitize: (input: unknown) => (typeof input === 'string' ? input : String(input))
};
