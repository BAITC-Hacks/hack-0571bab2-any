export class ApiFailure extends Error {
  constructor(message: string, public code: string, public available?: number, public status?: number) {
    super(message);
  }
}
