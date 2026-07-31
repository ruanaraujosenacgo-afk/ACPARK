export class StorageConfigurationError extends Error {
  constructor(message = "Storage nao configurado.") {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export class StorageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageValidationError";
    this.statusCode = 400;
  }
}
