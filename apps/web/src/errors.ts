export class ApiFailure extends Error {
  constructor(message: string, public code: string, public available?: number) {
    super(message);
  }
}
