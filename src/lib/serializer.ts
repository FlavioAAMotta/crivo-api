if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

/**
 * Recursively converts BigInt properties in an object to strings.
 * Safe for use on payloads before JWT signing or manual response building.
 */
export function serializeBigInt<T>(obj: T): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  // Date é `typeof 'object'` com zero chaves próprias: cair no ramo genérico
  // abaixo a reescreveria como `{}` e apagaria toda data da resposta.
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  }
  if (typeof obj === 'object') {
    const serialized: any = {};
    for (const key of Object.keys(obj)) {
      serialized[key] = serializeBigInt((obj as any)[key]);
    }
    return serialized;
  }
  return obj;
}
