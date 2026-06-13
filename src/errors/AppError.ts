// Authorized by HUB-79 — AppError class for expected HTTP errors with canonical response format
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
