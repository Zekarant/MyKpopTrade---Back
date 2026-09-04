const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FetchJsonWithRetryOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  /** Extrait le contenu texte d'une réponse HTTP 2xx ; undefined si vide/inattendu (déclenche un retry). */
  extractContent: (payload: any) => string | undefined;
  /** Extrait un message d'erreur du corps d'une réponse HTTP non-2xx (best-effort). */
  extractErrorMessage?: (payload: any) => string | undefined;
}

/**
 * POST JSON générique avec retries (backoff linéaire, timeout par tentative),
 * partagé par les adapters Mistral et Gemini (`mistralClient.ts`, `geminiClient.ts`).
 * Un 4xx (hors 429) arrête immédiatement les tentatives : la requête est en cause,
 * pas la disponibilité du service. Retourne le contenu extrait par `extractContent`,
 * ou lève une erreur avec le dernier message d'échec rencontré.
 */
export const fetchJsonWithRetry = async ({
  url,
  headers,
  body,
  timeoutMs,
  maxAttempts,
  backoffMs,
  extractContent,
  extractErrorMessage
}: FetchJsonWithRetryOptions): Promise<string> => {
  let lastError = 'échec inconnu';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        lastError = (errorPayload && extractErrorMessage?.(errorPayload)) || `HTTP ${response.status}`;
        // 4xx (hors 429) : inutile de réessayer, la requête est en cause.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          break;
        }
      } else {
        const payload = await response.json();
        const content = extractContent(payload);
        if (content) {
          return content;
        }
        lastError = 'réponse vide';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < maxAttempts) {
      await sleep(backoffMs * attempt);
    }
  }

  throw new Error(lastError);
};
