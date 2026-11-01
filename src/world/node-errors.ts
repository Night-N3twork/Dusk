const captureStack = (err: Error, ctor: Function): void => {
  const cs = (Error as unknown as { captureStackTrace?: (e: Error, c: Function) => void }).captureStackTrace;
  if (typeof cs === 'function') {
    try { cs(err, ctor); } catch { /* */ }
  }
};

const tagOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

const makeError = <T extends Error>(Cls: new (msg: string) => T, code: string, message: string, extras?: Record<string, unknown>): T => {
  const err = new Cls(message);
  (err as unknown as Record<string, unknown>)['code'] = code;
  if (extras) {
    for (const k in extras) (err as unknown as Record<string, unknown>)[k] = extras[k];
  }
  return err;
};

export type ErrorFactory = (...args: unknown[]) => Error;

const codes_: Record<string, ErrorFactory> = {};

const def = (code: string, fn: ErrorFactory): void => {
  codes_[code] = (...args: unknown[]) => {
    const err = fn(...args);
    captureStack(err, codes_[code]!);
    return err;
  };
};

def('ERR_INVALID_ARG_TYPE', (name: unknown, expected: unknown, actual: unknown) => {
  const n = String(name);
  const exp = Array.isArray(expected) ? (expected as unknown[]).join(' | ') : String(expected);
  const got = tagOf(actual);
  return makeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${n}" argument must be of type ${exp}. Received ${got}`);
});

def('ERR_INVALID_ARG_VALUE', (name: unknown, value: unknown, reason?: unknown) => {
  const n = String(name);
  const r = reason ? ` ${String(reason)}` : '';
  return makeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument '${n}' is invalid.${r} Received ${typeof value === 'string' ? `'${value}'` : tagOf(value)}`);
});

def('ERR_OUT_OF_RANGE', (name: unknown, range: unknown, actual: unknown) => {
  const n = String(name);
  return makeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${n}" is out of range. It must be ${String(range)}. Received ${String(actual)}`);
});

def('ERR_MISSING_ARGS', (...names: unknown[]) => {
  const list = names.map((n) => `"${String(n)}"`).join(', ');
  return makeError(TypeError, 'ERR_MISSING_ARGS', `The ${list} arguments must be specified`);
});

def('ERR_INVALID_THIS', (type: unknown) => makeError(TypeError, 'ERR_INVALID_THIS', `Value of "this" must be of type ${String(type)}`));

def('ERR_UNSUPPORTED', (feature: unknown) => makeError(Error, 'ERR_UNSUPPORTED', `Unsupported: ${String(feature)}`));

def('ERR_METHOD_NOT_IMPLEMENTED', (method: unknown) => makeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', `The ${String(method)} method is not implemented`));

def('ERR_OPERATION_FAILED', (op: unknown, reason?: unknown) => {
  const r = reason ? `: ${String(reason)}` : '';
  return makeError(Error, 'ERR_OPERATION_FAILED', `Operation failed: ${String(op)}${r}`);
});

def('ERR_INVALID_STATE', (reason: unknown) => makeError(Error, 'ERR_INVALID_STATE', `Invalid state: ${String(reason)}`));

def('ERR_CONSTRUCT_CALL_REQUIRED', (name: unknown) => makeError(TypeError, 'ERR_CONSTRUCT_CALL_REQUIRED', `Class constructor ${String(name)} cannot be invoked without 'new'`));

def('ERR_ASSERTION', (msg: unknown) => makeError(Error, 'ERR_ASSERTION', String(msg)));

def('ERR_INTERNAL_ASSERTION', (msg: unknown) => makeError(Error, 'ERR_INTERNAL_ASSERTION', `Internal assertion failed: ${String(msg)}`));

def('ERR_INVALID_RETURN_VALUE', (expected: unknown, fnName: unknown, actual: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_RETURN_VALUE', `Expected ${String(expected)} to be returned from the "${String(fnName)}" function but got ${tagOf(actual)}`);
});

def('ERR_INVALID_CALLBACK', (actual: unknown) => makeError(TypeError, 'ERR_INVALID_CALLBACK', `Callback must be a function. Received ${tagOf(actual)}`));

def('ERR_BUFFER_OUT_OF_BOUNDS', () => makeError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', 'Attempt to access memory outside buffer bounds'));

def('ERR_BUFFER_TOO_LARGE', (max: unknown) => makeError(RangeError, 'ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${String(max)} bytes`));

def('ERR_ENCODING_NOT_SUPPORTED', (enc: unknown) => makeError(RangeError, 'ERR_ENCODING_NOT_SUPPORTED', `The "${String(enc)}" encoding is not supported`));

def('ERR_ENCODING_INVALID_ENCODED_DATA', (enc: unknown, reason?: unknown) => {
  const r = reason ? `: ${String(reason)}` : '';
  return makeError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', `The encoded data was not valid for encoding ${String(enc)}${r}`);
});

def('ERR_INVALID_URL', (input: unknown) => {
  const err = makeError(TypeError, 'ERR_INVALID_URL', `Invalid URL: ${String(input)}`);
  (err as unknown as Record<string, unknown>)['input'] = input;
  return err;
});

def('ERR_INVALID_URL_SCHEME', (expected: unknown) => makeError(TypeError, 'ERR_INVALID_URL_SCHEME', `The URL must be ${String(expected)}`));

def('ERR_INVALID_FILE_URL_PATH', (reason: unknown) => makeError(TypeError, 'ERR_INVALID_FILE_URL_PATH', `File URL path ${String(reason)}`));

def('ERR_INCOMPATIBLE_OPTION_PAIR', (a: unknown, b: unknown) => makeError(TypeError, 'ERR_INCOMPATIBLE_OPTION_PAIR', `Option "${String(a)}" cannot be used in combination with option "${String(b)}"`));

def('ERR_MODULE_NOT_FOUND', (specifier: unknown, base?: unknown) => {
  const b = base ? ` imported from ${String(base)}` : '';
  return makeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find module '${String(specifier)}'${b}`);
});

def('ERR_UNSUPPORTED_DIR_IMPORT', (specifier: unknown, base: unknown) => {
  return makeError(Error, 'ERR_UNSUPPORTED_DIR_IMPORT', `Directory import '${String(specifier)}' is not supported resolving ES modules imported from ${String(base)}`);
});

def('ERR_UNSUPPORTED_ESM_URL_SCHEME', (scheme: unknown) => {
  return makeError(Error, 'ERR_UNSUPPORTED_ESM_URL_SCHEME', `Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received '${String(scheme)}:'`);
});

def('ERR_PACKAGE_PATH_NOT_EXPORTED', (pkg: unknown, path: unknown) => {
  return makeError(Error, 'ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${String(path)}' is not defined by "exports" in ${String(pkg)}/package.json`);
});

def('ERR_INVALID_PACKAGE_CONFIG', (path: unknown, reason?: unknown) => {
  const r = reason ? `: ${String(reason)}` : '';
  return makeError(Error, 'ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${String(path)}${r}`);
});

def('ERR_INVALID_PACKAGE_TARGET', (pkg: unknown, key: unknown, target: unknown) => {
  return makeError(Error, 'ERR_INVALID_PACKAGE_TARGET', `Invalid "exports" target ${JSON.stringify(target)} defined for '${String(key)}' in the package config ${String(pkg)}/package.json`);
});

def('ERR_INVALID_MODULE_SPECIFIER', (specifier: unknown, reason: unknown, base?: unknown) => {
  const b = base ? ` imported from ${String(base)}` : '';
  return makeError(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${String(specifier)}" ${String(reason)}${b}`);
});

def('ERR_REQUIRE_ESM', (specifier: unknown) => {
  return makeError(Error, 'ERR_REQUIRE_ESM', `require() of ES Module ${String(specifier)} is not supported`);
});

def('ERR_UNHANDLED_ERROR', (err?: unknown) => {
  const detail = err === undefined ? '' : ` (${String(err)})`;
  return makeError(Error, 'ERR_UNHANDLED_ERROR', `Unhandled error.${detail}`);
});

def('ERR_FS_FILE_TOO_LARGE', (size: unknown) => makeError(RangeError, 'ERR_FS_FILE_TOO_LARGE', `File size (${String(size)}) is greater than 2 GiB`));

def('ERR_FS_INVALID_SYMLINK_TYPE', (type: unknown) => makeError(Error, 'ERR_FS_INVALID_SYMLINK_TYPE', `Symlink type must be one of "dir", "file", or "junction". Received "${String(type)}"`));

def('ERR_FS_EISDIR', (path: unknown) => makeError(Error, 'ERR_FS_EISDIR', `Path is a directory: ${String(path)}`));

def('ERR_INVALID_FD', (fd: unknown) => makeError(RangeError, 'ERR_INVALID_FD', `"fd" must be a positive integer: ${String(fd)}`));

def('ERR_INVALID_FD_TYPE', (actual: unknown) => makeError(TypeError, 'ERR_INVALID_FD_TYPE', `Unsupported fd type: ${tagOf(actual)}`));

def('ERR_UNKNOWN_SIGNAL', (signal: unknown) => makeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${String(signal)}`));

def('ERR_INVALID_EXIT_CODE', (code: unknown) => makeError(RangeError, 'ERR_INVALID_EXIT_CODE', `Invalid exit code: ${String(code)}`));

def('ERR_PROCESS_NOT_RUNNING', () => makeError(Error, 'ERR_PROCESS_NOT_RUNNING', 'Process is not running'));

def('ERR_IPC_DISCONNECTED', () => makeError(Error, 'ERR_IPC_DISCONNECTED', 'IPC channel is already disconnected'));

def('ERR_IPC_CHANNEL_CLOSED', () => makeError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed'));

def('ERR_CRYPTO_INVALID_DIGEST', (alg: unknown) => makeError(TypeError, 'ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${String(alg)}`));

def('ERR_CRYPTO_INVALID_KEYLEN', (len: unknown) => makeError(RangeError, 'ERR_CRYPTO_INVALID_KEYLEN', `Invalid key length: ${String(len)}`));

def('ERR_CRYPTO_INVALID_IV', () => makeError(TypeError, 'ERR_CRYPTO_INVALID_IV', 'Invalid IV'));

def('ERR_CRYPTO_INVALID_AUTH_TAG', () => makeError(TypeError, 'ERR_CRYPTO_INVALID_AUTH_TAG', 'Invalid auth tag'));

def('ERR_CRYPTO_INVALID_STATE', (op: unknown) => makeError(Error, 'ERR_CRYPTO_INVALID_STATE', `Invalid state for operation: ${String(op)}`));

def('ERR_CRYPTO_UNSUPPORTED_OPERATION', (op: unknown) => makeError(Error, 'ERR_CRYPTO_UNSUPPORTED_OPERATION', `Unsupported crypto operation: ${String(op)}`));

def('ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', () => makeError(RangeError, 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length'));

def('ERR_STREAM_CANNOT_PIPE', () => makeError(Error, 'ERR_STREAM_CANNOT_PIPE', 'Cannot pipe, not readable'));

def('ERR_STREAM_DESTROYED', (method: unknown) => makeError(Error, 'ERR_STREAM_DESTROYED', `Cannot call ${String(method)} after a stream was destroyed`));

def('ERR_STREAM_ALREADY_FINISHED', (method: unknown) => makeError(Error, 'ERR_STREAM_ALREADY_FINISHED', `Cannot call ${String(method)} after a stream was finished`));

def('ERR_STREAM_NULL_VALUES', () => makeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream'));

def('ERR_STREAM_PREMATURE_CLOSE', () => makeError(Error, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close'));

def('ERR_STREAM_PUSH_AFTER_EOF', () => makeError(Error, 'ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF'));

def('ERR_STREAM_UNSHIFT_AFTER_END_EVENT', () => makeError(Error, 'ERR_STREAM_UNSHIFT_AFTER_END_EVENT', 'stream.unshift() after end event'));

def('ERR_STREAM_WRITE_AFTER_END', () => makeError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end'));

def('ERR_MULTIPLE_CALLBACK', () => makeError(Error, 'ERR_MULTIPLE_CALLBACK', 'Callback called multiple times'));

def('ERR_SOCKET_BAD_PORT', (name: unknown, port: unknown, allowZero?: unknown) => {
  const lo = allowZero ? 0 : 1;
  return makeError(RangeError, 'ERR_SOCKET_BAD_PORT', `${String(name)} should be >= ${lo} and < 65536. Received ${String(port)}`);
});

def('ERR_SOCKET_BAD_TYPE', () => makeError(TypeError, 'ERR_SOCKET_BAD_TYPE', 'Bad socket type specified'));

def('ERR_SOCKET_CLOSED', () => makeError(Error, 'ERR_SOCKET_CLOSED', 'Socket is closed'));

def('ERR_SOCKET_CONNECTION_TIMEOUT', () => makeError(Error, 'ERR_SOCKET_CONNECTION_TIMEOUT', 'Socket connection timeout'));

def('ERR_SERVER_ALREADY_LISTEN', () => makeError(Error, 'ERR_SERVER_ALREADY_LISTEN', 'Listen method has been called more than once without closing'));

def('ERR_SERVER_NOT_RUNNING', () => makeError(Error, 'ERR_SERVER_NOT_RUNNING', 'Server is not running'));

def('ERR_HTTP_HEADERS_SENT', (action: unknown) => makeError(Error, 'ERR_HTTP_HEADERS_SENT', `Cannot ${String(action)} headers after they are sent to the client`));

def('ERR_HTTP_INVALID_HEADER_VALUE', (value: unknown, name: unknown) => makeError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', `Invalid value "${String(value)}" for header "${String(name)}"`));

def('ERR_HTTP_INVALID_STATUS_CODE', (code: unknown) => makeError(RangeError, 'ERR_HTTP_INVALID_STATUS_CODE', `Invalid status code: ${String(code)}`));

def('ERR_INVALID_HTTP_TOKEN', (name: unknown, field: unknown) => makeError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `${String(name)} must be a valid HTTP token ["${String(field)}"]`));

def('ERR_INVALID_PROTOCOL', (actual: unknown, expected: unknown) => makeError(TypeError, 'ERR_INVALID_PROTOCOL', `Protocol "${String(actual)}" not supported. Expected "${String(expected)}"`));

def('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', (stdio: unknown) => makeError(RangeError, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', `${String(stdio)} maxBuffer length exceeded`));

def('ERR_INVALID_SYNC_FORK_INPUT', (type: unknown) => makeError(TypeError, 'ERR_INVALID_SYNC_FORK_INPUT', `Asynchronous forks do not support Buffer, TypedArray, DataView or string input: ${String(type)}`));

def('ERR_ZLIB_INITIALIZATION_FAILED', () => makeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed'));

def('ERR_UNHANDLED_REJECTION', (reason: unknown) => makeError(Error, 'ERR_UNHANDLED_REJECTION', `Unhandled promise rejection: ${String(reason)}`));

def('ERR_INVALID_RETURN_TYPE', (expected: unknown, fnName: unknown, actual: unknown) => makeError(TypeError, 'ERR_INVALID_RETURN_TYPE', `Expected ${String(expected)} to be returned from the "${String(fnName)}" function but got ${tagOf(actual)}`));

def('ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET', () => makeError(Error, 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET', '`process.setUncaughtExceptionCaptureCallback()` was called while a capture callback was already active'));

// ---- Additional codes (round-out the dictionary) ----

def('ERR_ARG_NOT_ITERABLE', (name: unknown) => makeError(TypeError, 'ERR_ARG_NOT_ITERABLE', `${String(name)} must be iterable`));
def('ERR_AMBIGUOUS_ARGUMENT', (name: unknown, reason: unknown) => makeError(TypeError, 'ERR_AMBIGUOUS_ARGUMENT', `The argument '${String(name)}' is ambiguous. ${String(reason)}`));
def('ERR_API_NO_LONGER_VALID', (method: unknown) => makeError(Error, 'ERR_API_NO_LONGER_VALID', `${String(method)} is no longer valid`));
def('ERR_CHILD_CLOSED_BEFORE_REPLY', () => makeError(Error, 'ERR_CHILD_CLOSED_BEFORE_REPLY', 'Child closed before reply received'));
def('ERR_CHILD_PROCESS_IPC_REQUIRED', (option: unknown) => makeError(Error, 'ERR_CHILD_PROCESS_IPC_REQUIRED', `Forked processes must have an IPC channel; missing value for options.${String(option)}`));
def('ERR_CONNECTION_REFUSED', () => makeError(Error, 'ERR_CONNECTION_REFUSED', 'Connection refused'));
def('ERR_CONSOLE_WRITABLE_STREAM', (name: unknown) => makeError(TypeError, 'ERR_CONSOLE_WRITABLE_STREAM', `Console expects a writable stream instance for ${String(name)}`));
def('ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED', () => makeError(Error, 'ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED', 'Custom engines not supported'));
def('ERR_CRYPTO_ECDH_INVALID_FORMAT', (format: unknown) => makeError(RangeError, 'ERR_CRYPTO_ECDH_INVALID_FORMAT', `Invalid ECDH format: ${String(format)}`));
def('ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY', () => makeError(Error, 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY', 'Public key is not valid for specified curve'));
def('ERR_CRYPTO_ENGINE_UNKNOWN', (name: unknown) => makeError(Error, 'ERR_CRYPTO_ENGINE_UNKNOWN', `Engine not found: ${String(name)}`));
def('ERR_CRYPTO_FIPS_FORCED', () => makeError(Error, 'ERR_CRYPTO_FIPS_FORCED', 'Cannot set FIPS mode'));
def('ERR_CRYPTO_FIPS_UNAVAILABLE', () => makeError(Error, 'ERR_CRYPTO_FIPS_UNAVAILABLE', 'FIPS support unavailable'));
def('ERR_CRYPTO_HASH_FINALIZED', () => makeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called'));
def('ERR_CRYPTO_HASH_UPDATE_FAILED', () => makeError(Error, 'ERR_CRYPTO_HASH_UPDATE_FAILED', 'Hash update failed'));
def('ERR_CRYPTO_HMAC_FINALIZED', () => makeError(Error, 'ERR_CRYPTO_HMAC_FINALIZED', 'Hmac already finalized'));
def('ERR_CRYPTO_INVALID_CURVE', () => makeError(TypeError, 'ERR_CRYPTO_INVALID_CURVE', 'Invalid EC curve name'));
def('ERR_CRYPTO_INVALID_JWK', () => makeError(TypeError, 'ERR_CRYPTO_INVALID_JWK', 'Invalid JWK data'));
def('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', (type: unknown, expected: unknown) => makeError(TypeError, 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Invalid key object type ${String(type)}, expected ${String(expected)}`));
def('ERR_CRYPTO_INVALID_KEY_PAIR', () => makeError(Error, 'ERR_CRYPTO_INVALID_KEY_PAIR', 'Invalid key pair'));
def('ERR_CRYPTO_INVALID_TAG_LENGTH', (len: unknown) => makeError(RangeError, 'ERR_CRYPTO_INVALID_TAG_LENGTH', `Invalid authentication tag length: ${String(len)}`));
def('ERR_CRYPTO_JOB_INIT_FAILED', () => makeError(Error, 'ERR_CRYPTO_JOB_INIT_FAILED', 'Crypto job init failed'));
def('ERR_CRYPTO_JWK_UNSUPPORTED_CURVE', () => makeError(Error, 'ERR_CRYPTO_JWK_UNSUPPORTED_CURVE', 'Unsupported JWK curve'));
def('ERR_CRYPTO_PBKDF2_ERROR', () => makeError(Error, 'ERR_CRYPTO_PBKDF2_ERROR', 'PBKDF2 error'));
def('ERR_CRYPTO_INVALID_SCRYPT_PARAMS', (detail?: unknown) => makeError(RangeError, 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS', detail === undefined ? 'Invalid scrypt params' : `Invalid scrypt params: ${String(detail)}`));
def('ERR_CRYPTO_SCRYPT_INVALID_PARAMETER', () => makeError(Error, 'ERR_CRYPTO_SCRYPT_INVALID_PARAMETER', 'Invalid scrypt parameter'));
def('ERR_CRYPTO_SCRYPT_NOT_SUPPORTED', () => makeError(Error, 'ERR_CRYPTO_SCRYPT_NOT_SUPPORTED', 'Scrypt algorithm not supported'));
def('ERR_CRYPTO_SIGN_KEY_REQUIRED', () => makeError(Error, 'ERR_CRYPTO_SIGN_KEY_REQUIRED', 'No key provided to sign'));
def('ERR_CRYPTO_UNKNOWN_CIPHER', (cipher: unknown) => makeError(Error, 'ERR_CRYPTO_UNKNOWN_CIPHER', `Unknown cipher: ${String(cipher)}`));
def('ERR_CRYPTO_UNKNOWN_DH_GROUP', () => makeError(Error, 'ERR_CRYPTO_UNKNOWN_DH_GROUP', 'Unknown DH group'));
def('ERR_DEBUGGER_ERROR', (msg: unknown) => makeError(Error, 'ERR_DEBUGGER_ERROR', String(msg)));
def('ERR_DEBUGGER_STARTUP_ERROR', (msg: unknown) => makeError(Error, 'ERR_DEBUGGER_STARTUP_ERROR', String(msg)));
def('ERR_DIR_CLOSED', () => makeError(Error, 'ERR_DIR_CLOSED', 'Directory handle was closed'));
def('ERR_DIR_CONCURRENT_OPERATION', () => makeError(Error, 'ERR_DIR_CONCURRENT_OPERATION', 'Cannot do synchronous work on directory handle with concurrent asynchronous operations'));
def('ERR_DNS_SET_SERVERS_FAILED', (err: unknown, config: unknown) => makeError(Error, 'ERR_DNS_SET_SERVERS_FAILED', `c-ares failed to set servers: "${String(err)}" [${String(config)}]`));
def('ERR_DOMAIN_CALLBACK_NOT_AVAILABLE', () => makeError(Error, 'ERR_DOMAIN_CALLBACK_NOT_AVAILABLE', 'A callback was registered through `process.setUncaughtExceptionCaptureCallback()`'));
def('ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE', () => makeError(Error, 'ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE', 'The `domain` module is in use'));
def('ERR_EVAL_ESM_CANNOT_PRINT', () => makeError(Error, 'ERR_EVAL_ESM_CANNOT_PRINT', '--print cannot be used with ESM input'));
def('ERR_EVENT_RECURSION', (type: unknown) => makeError(Error, 'ERR_EVENT_RECURSION', `The event "${String(type)}" is already being dispatched`));
def('ERR_FALSY_VALUE_REJECTION', () => makeError(Error, 'ERR_FALSY_VALUE_REJECTION', 'Promise was rejected with a falsy value'));
def('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', (feat: unknown) => makeError(TypeError, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `The feature ${String(feat)} is unavailable on the current platform`));
def('ERR_FS_CP_DIR_TO_NON_DIR', () => makeError(Error, 'ERR_FS_CP_DIR_TO_NON_DIR', 'Cannot overwrite non-directory with directory'));
def('ERR_FS_CP_EEXIST', () => makeError(Error, 'ERR_FS_CP_EEXIST', 'Target already exists'));
def('ERR_FS_CP_EINVAL', () => makeError(Error, 'ERR_FS_CP_EINVAL', 'Invalid src or dest'));
def('ERR_FS_CP_FIFO_PIPE', () => makeError(Error, 'ERR_FS_CP_FIFO_PIPE', 'Cannot copy a FIFO pipe'));
def('ERR_FS_CP_NON_DIR_TO_DIR', () => makeError(Error, 'ERR_FS_CP_NON_DIR_TO_DIR', 'Cannot overwrite directory with non-directory'));
def('ERR_FS_CP_SOCKET', () => makeError(Error, 'ERR_FS_CP_SOCKET', 'Cannot copy a socket'));
def('ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', () => makeError(Error, 'ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', 'Cannot overwrite symlink in subdirectory of self'));
def('ERR_FS_CP_UNKNOWN', () => makeError(Error, 'ERR_FS_CP_UNKNOWN', 'Cannot copy an unknown file type'));
def('ERR_FS_DIR_NOT_OPENED', () => makeError(Error, 'ERR_FS_DIR_NOT_OPENED', 'Directory handle is not opened'));
def('ERR_HOST_UNREACHABLE', () => makeError(Error, 'ERR_HOST_UNREACHABLE', 'Host is unreachable'));
def('ERR_HTTP_BODY_NOT_ALLOWED', () => makeError(Error, 'ERR_HTTP_BODY_NOT_ALLOWED', 'Adding content for this method is not allowed'));
def('ERR_HTTP_CONTENT_LENGTH_MISMATCH', () => makeError(Error, 'ERR_HTTP_CONTENT_LENGTH_MISMATCH', 'Response body has a different size than the Content-Length header'));
def('ERR_HTTP_REQUEST_TIMEOUT', () => makeError(Error, 'ERR_HTTP_REQUEST_TIMEOUT', 'Request timeout'));
def('ERR_HTTP_SOCKET_ASSIGNED', () => makeError(Error, 'ERR_HTTP_SOCKET_ASSIGNED', 'ServerResponse has an already-assigned socket'));
def('ERR_HTTP_SOCKET_ENCODING', () => makeError(Error, 'ERR_HTTP_SOCKET_ENCODING', 'Changing the socket encoding is not allowed'));
def('ERR_HTTP_TRAILER_INVALID', () => makeError(Error, 'ERR_HTTP_TRAILER_INVALID', 'Trailers are invalid with this transfer encoding'));
def('ERR_HTTP2_ALTSVC_INVALID_ORIGIN', () => makeError(TypeError, 'ERR_HTTP2_ALTSVC_INVALID_ORIGIN', 'HTTP/2 ALTSVC frames require a valid origin'));
def('ERR_IMPORT_ATTRIBUTE_MISSING', (specifier: unknown, attr: unknown) => makeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_MISSING', `Module "${String(specifier)}" needs an import attribute of "${String(attr)}"`));
def('ERR_INSPECTOR_ALREADY_ACTIVATED', () => makeError(Error, 'ERR_INSPECTOR_ALREADY_ACTIVATED', 'Inspector is already activated'));
def('ERR_INSPECTOR_ALREADY_CONNECTED', (caller: unknown) => makeError(Error, 'ERR_INSPECTOR_ALREADY_CONNECTED', `${String(caller)} is already connected`));
def('ERR_INSPECTOR_CLOSED', () => makeError(Error, 'ERR_INSPECTOR_CLOSED', 'Session was closed'));
def('ERR_INSPECTOR_COMMAND', (code: unknown, msg: unknown) => makeError(Error, 'ERR_INSPECTOR_COMMAND', `Inspector error ${String(code)}: ${String(msg)}`));
def('ERR_INSPECTOR_NOT_AVAILABLE', () => makeError(Error, 'ERR_INSPECTOR_NOT_AVAILABLE', 'Inspector is not available'));
def('ERR_INSPECTOR_NOT_CONNECTED', () => makeError(Error, 'ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected'));
def('ERR_INSPECTOR_NOT_WORKER', () => makeError(Error, 'ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker'));
def('ERR_INVALID_ADDRESS_FAMILY', (family: unknown, host: unknown, port: unknown) => makeError(RangeError, 'ERR_INVALID_ADDRESS_FAMILY', `Invalid address family: ${String(family)} ${String(host)}:${String(port)}`));
def('ERR_INVALID_ASYNC_ID', (type: unknown, asyncId: unknown) => makeError(RangeError, 'ERR_INVALID_ASYNC_ID', `Invalid ${String(type)} value: ${String(asyncId)}`));
def('ERR_INVALID_BUFFER_SIZE', (reason: unknown) => makeError(RangeError, 'ERR_INVALID_BUFFER_SIZE', `Buffer size must be a multiple of ${String(reason)}`));
def('ERR_INVALID_CHAR', (name: unknown, field: unknown) => makeError(TypeError, 'ERR_INVALID_CHAR', `Invalid character in ${String(name)} [${String(field)}]`));
def('ERR_INVALID_CURSOR_POS', () => makeError(TypeError, 'ERR_INVALID_CURSOR_POS', 'Cannot set cursor row without setting its column'));
def('ERR_INVALID_FILE_URL_HOST', (platform: unknown) => makeError(TypeError, 'ERR_INVALID_FILE_URL_HOST', `File URL host must be "localhost" or empty on ${String(platform)}`));
def('ERR_INVALID_HANDLE_TYPE', () => makeError(TypeError, 'ERR_INVALID_HANDLE_TYPE', 'This handle type cannot be sent'));
def('ERR_INVALID_OPT_VALUE', (name: unknown, value: unknown) => makeError(TypeError, 'ERR_INVALID_OPT_VALUE', `The value "${String(value)}" is invalid for option "${String(name)}"`));
def('ERR_INVALID_OPT_VALUE_ENCODING', (encoding: unknown) => makeError(TypeError, 'ERR_INVALID_OPT_VALUE_ENCODING', `The value "${String(encoding)}" is invalid for option "encoding"`));
def('ERR_INVALID_PERFORMANCE_MARK', (name: unknown) => makeError(Error, 'ERR_INVALID_PERFORMANCE_MARK', `The "${String(name)}" performance mark has not been set`));
def('ERR_INVALID_TUPLE', (name: unknown, reason: unknown) => makeError(TypeError, 'ERR_INVALID_TUPLE', `${String(name)} must be ${String(reason)}`));
def('ERR_INVALID_URI', () => makeError(URIError, 'ERR_INVALID_URI', 'URI malformed'));
def('ERR_MEMORY_ALLOCATION_FAILED', () => makeError(Error, 'ERR_MEMORY_ALLOCATION_FAILED', 'Failed to allocate memory'));
def('ERR_METHOD_NOT_IMPLEMENTED', (method: unknown) => makeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', `${String(method)} is not implemented`));
def('ERR_MISSING_OPTION', (name: unknown) => makeError(TypeError, 'ERR_MISSING_OPTION', `${String(name)} is required`));
def('ERR_MISSING_PASSPHRASE', () => makeError(TypeError, 'ERR_MISSING_PASSPHRASE', 'Passphrase required for encrypted key'));
def('ERR_MISSING_PLATFORM_FOR_WORKER', () => makeError(Error, 'ERR_MISSING_PLATFORM_FOR_WORKER', 'The V8 platform used by this instance of Node does not support creating Workers'));
def('ERR_MULTIPLE_CALLBACK', () => makeError(Error, 'ERR_MULTIPLE_CALLBACK', 'Callback called multiple times'));
def('ERR_NAPI_INVALID_DATAVIEW_ARGS', () => makeError(RangeError, 'ERR_NAPI_INVALID_DATAVIEW_ARGS', 'byte_offset + byte_length exceeds the buffer'));
def('ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT', () => makeError(RangeError, 'ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT', 'start offset is not aligned'));
def('ERR_NAPI_INVALID_TYPEDARRAY_LENGTH', () => makeError(RangeError, 'ERR_NAPI_INVALID_TYPEDARRAY_LENGTH', 'Invalid typed array length'));
def('ERR_NAPI_TSFN_CALL_JS', () => makeError(Error, 'ERR_NAPI_TSFN_CALL_JS', 'Could not call the JS function'));
def('ERR_NAPI_TSFN_GET_UNDEFINED', () => makeError(Error, 'ERR_NAPI_TSFN_GET_UNDEFINED', 'Could not get the default undefined value'));
def('ERR_NETWORK_IMPORT_BAD_RESPONSE', (specifier: unknown, reason: unknown) => makeError(Error, 'ERR_NETWORK_IMPORT_BAD_RESPONSE', `Network import bad response for "${String(specifier)}": ${String(reason)}`));
def('ERR_NETWORK_IMPORT_DISALLOWED', (specifier: unknown, parent: unknown, reason: unknown) => makeError(Error, 'ERR_NETWORK_IMPORT_DISALLOWED', `Import disallowed for "${String(specifier)}" from "${String(parent)}": ${String(reason)}`));
def('ERR_NO_CRYPTO', () => makeError(Error, 'ERR_NO_CRYPTO', 'Node.js is not compiled with OpenSSL crypto support'));
def('ERR_NO_ICU', (feat: unknown) => makeError(TypeError, 'ERR_NO_ICU', `${String(feat)} is not supported on Node.js compiled without ICU`));
def('ERR_NON_CONTEXT_AWARE_DISABLED', () => makeError(Error, 'ERR_NON_CONTEXT_AWARE_DISABLED', 'Loading non-context-aware native modules has been disabled'));
def('ERR_NOT_BUILDING_SNAPSHOT', () => makeError(Error, 'ERR_NOT_BUILDING_SNAPSHOT', 'Operation cannot be invoked when not building startup snapshot'));
def('ERR_NOT_IMPLEMENTED', (feature: unknown) => makeError(Error, 'ERR_NOT_IMPLEMENTED', `${String(feature)} is not implemented`));
def('ERR_NO_LONGER_SUPPORTED', (feat: unknown) => makeError(Error, 'ERR_NO_LONGER_SUPPORTED', `${String(feat)} is no longer supported`));
def('ERR_OPERATION_FAILED', (op: unknown) => makeError(Error, 'ERR_OPERATION_FAILED', `Operation failed: ${String(op)}`));
def('ERR_OUT_OF_RANGE', (name: unknown, range: unknown, actual: unknown) => makeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${String(name)}" is out of range. It must be ${String(range)}. Received ${String(actual)}`));
def('ERR_PACKAGE_IMPORT_NOT_DEFINED', (specifier: unknown, base: unknown, pkg: unknown) => makeError(Error, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${String(specifier)}" is not defined in ${String(pkg)} imported from ${String(base)}`));
def('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', (option: unknown, value: unknown) => makeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${String(option)}' has invalid value: ${String(value)}`));
def('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', (arg: unknown) => makeError(TypeError, 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', `Unexpected positional argument: ${String(arg)}`));
def('ERR_PARSE_ARGS_UNKNOWN_OPTION', (option: unknown) => makeError(TypeError, 'ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option: ${String(option)}`));
def('ERR_PROCESS_NOT_RUNNING', () => makeError(Error, 'ERR_PROCESS_NOT_RUNNING', 'Process is not running'));
def('ERR_QUIC_OPERATION_FAILED', () => makeError(Error, 'ERR_QUIC_OPERATION_FAILED', 'QUIC operation failed'));
def('ERR_REQUIRE_CYCLE_MODULE', (msg: unknown) => makeError(Error, 'ERR_REQUIRE_CYCLE_MODULE', String(msg)));
def('ERR_REQUIRE_ASYNC_MODULE', (msg: unknown) => makeError(Error, 'ERR_REQUIRE_ASYNC_MODULE', String(msg)));
def('ERR_SCRIPT_EXECUTION_INTERRUPTED', () => makeError(Error, 'ERR_SCRIPT_EXECUTION_INTERRUPTED', 'Script execution was interrupted by SIGINT'));
def('ERR_SCRIPT_EXECUTION_TIMEOUT', (timeout: unknown) => makeError(Error, 'ERR_SCRIPT_EXECUTION_TIMEOUT', `Script execution timed out after ${String(timeout)}ms`));
def('ERR_SERVER_NOT_RUNNING', () => makeError(Error, 'ERR_SERVER_NOT_RUNNING', 'Server is not running'));
def('ERR_SOCKET_ALREADY_BOUND', () => makeError(Error, 'ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound'));
def('ERR_SOCKET_BUFFER_SIZE', () => makeError(Error, 'ERR_SOCKET_BUFFER_SIZE', 'Could not get or set buffer size'));
def('ERR_SOCKET_CANNOT_SEND', () => makeError(Error, 'ERR_SOCKET_CANNOT_SEND', 'Unable to send data'));
def('ERR_SOCKET_DGRAM_IS_CONNECTED', () => makeError(Error, 'ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected'));
def('ERR_SOCKET_DGRAM_NOT_CONNECTED', () => makeError(Error, 'ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected'));
def('ERR_SOCKET_DGRAM_NOT_RUNNING', () => makeError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running'));
def('ERR_SRI_PARSE', () => makeError(SyntaxError, 'ERR_SRI_PARSE', 'Subresource Integrity string could not be parsed'));
def('ERR_STREAM_ALREADY_FINISHED', (method: unknown) => makeError(Error, 'ERR_STREAM_ALREADY_FINISHED', `Cannot call ${String(method)} after a stream was finished`));
def('ERR_STREAM_DESTROYED', (method: unknown) => makeError(Error, 'ERR_STREAM_DESTROYED', `Cannot call ${String(method)} after a stream was destroyed`));
def('ERR_STREAM_NULL_VALUES', () => makeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream'));
def('ERR_STREAM_PUSH_AFTER_EOF', () => makeError(Error, 'ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF'));
def('ERR_STREAM_UNSHIFT_AFTER_END_EVENT', () => makeError(Error, 'ERR_STREAM_UNSHIFT_AFTER_END_EVENT', 'stream.unshift() after end event'));
def('ERR_STREAM_WRAP', () => makeError(Error, 'ERR_STREAM_WRAP', 'Stream has StringDecoder set or is in objectMode'));
def('ERR_SYNTHETIC', () => makeError(Error, 'ERR_SYNTHETIC', 'JavaScript Callstack'));
def('ERR_SYSTEM_ERROR', (msg: unknown) => makeError(Error, 'ERR_SYSTEM_ERROR', `A system error occurred: ${String(msg)}`));
def('ERR_TAP_LEXER_ERROR', (msg: unknown) => makeError(Error, 'ERR_TAP_LEXER_ERROR', `TAP lexer error: ${String(msg)}`));
def('ERR_TAP_PARSER_ERROR', (msg: unknown) => makeError(Error, 'ERR_TAP_PARSER_ERROR', `TAP parser error: ${String(msg)}`));
def('ERR_TAP_VALIDATION_ERROR', (msg: unknown) => makeError(Error, 'ERR_TAP_VALIDATION_ERROR', `TAP validation error: ${String(msg)}`));
def('ERR_TEST_FAILURE', (cause: unknown) => makeError(Error, 'ERR_TEST_FAILURE', `Test failure: ${String(cause)}`));
def('ERR_TLS_CERT_ALTNAME_FORMAT', () => makeError(SyntaxError, 'ERR_TLS_CERT_ALTNAME_FORMAT', 'Invalid subject alternative name string'));
def('ERR_TLS_CERT_ALTNAME_INVALID', (reason: unknown) => makeError(Error, 'ERR_TLS_CERT_ALTNAME_INVALID', `Hostname/IP does not match certificate's altnames: ${String(reason)}`));
def('ERR_TLS_DH_PARAM_SIZE', (size: unknown) => makeError(Error, 'ERR_TLS_DH_PARAM_SIZE', `DH parameter size ${String(size)} is less than 2048`));
def('ERR_TLS_HANDSHAKE_TIMEOUT', () => makeError(Error, 'ERR_TLS_HANDSHAKE_TIMEOUT', 'TLS handshake timeout'));
def('ERR_TLS_INVALID_CONTEXT', (name: unknown) => makeError(TypeError, 'ERR_TLS_INVALID_CONTEXT', `${String(name)} must be a SecureContext`));
def('ERR_TLS_INVALID_PROTOCOL_METHOD', (method: unknown) => makeError(TypeError, 'ERR_TLS_INVALID_PROTOCOL_METHOD', `Invalid TLS protocol method: ${String(method)}`));
def('ERR_TLS_INVALID_PROTOCOL_VERSION', (version: unknown, name: unknown) => makeError(TypeError, 'ERR_TLS_INVALID_PROTOCOL_VERSION', `${String(version)} is not a valid ${String(name)} version`));
def('ERR_TLS_INVALID_STATE', () => makeError(Error, 'ERR_TLS_INVALID_STATE', 'TLS socket connection must be securely established'));
def('ERR_TLS_PROTOCOL_VERSION_CONFLICT', () => makeError(TypeError, 'ERR_TLS_PROTOCOL_VERSION_CONFLICT', 'TLS protocol version mismatch'));
def('ERR_TLS_RENEGOTIATION_DISABLED', () => makeError(Error, 'ERR_TLS_RENEGOTIATION_DISABLED', 'TLS session renegotiation disabled'));
def('ERR_TLS_REQUIRED_SERVER_NAME', () => makeError(Error, 'ERR_TLS_REQUIRED_SERVER_NAME', '"servername" is required'));
def('ERR_TLS_SESSION_ATTACK', () => makeError(Error, 'ERR_TLS_SESSION_ATTACK', 'TLS session renegotiation attack detected'));
def('ERR_TLS_SNI_FROM_SERVER', () => makeError(Error, 'ERR_TLS_SNI_FROM_SERVER', 'Cannot issue SNI from a TLS server'));
def('ERR_TRACE_EVENTS_CATEGORY_REQUIRED', () => makeError(TypeError, 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED', 'At least one category is required'));
def('ERR_TRACE_EVENTS_UNAVAILABLE', () => makeError(Error, 'ERR_TRACE_EVENTS_UNAVAILABLE', 'Trace events are unavailable'));
def('ERR_TRANSFORM_ALREADY_TRANSFORMING', () => makeError(Error, 'ERR_TRANSFORM_ALREADY_TRANSFORMING', 'Calling transform done when still transforming'));
def('ERR_TRANSFORM_WITH_LENGTH_0', () => makeError(Error, 'ERR_TRANSFORM_WITH_LENGTH_0', 'Transform stream has data but no transform'));
def('ERR_TTY_INIT_FAILED', () => makeError(Error, 'ERR_TTY_INIT_FAILED', 'TTY initialization failed'));
def('ERR_UNAVAILABLE_DURING_EXIT', () => makeError(Error, 'ERR_UNAVAILABLE_DURING_EXIT', 'Cannot call function during the exit phase'));
def('ERR_UNHANDLED_ERROR', (err?: unknown) => makeError(Error, 'ERR_UNHANDLED_ERROR', `Unhandled error.${err !== undefined ? ` (${String(err)})` : ''}`));
def('ERR_UNHANDLED_REJECTION', (reason: unknown) => makeError(Error, 'ERR_UNHANDLED_REJECTION', `Unhandled promise rejection: ${String(reason)}`));
def('ERR_UNKNOWN_BUILTIN_MODULE', (name: unknown) => makeError(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${String(name)}`));
def('ERR_UNKNOWN_CREDENTIAL', (type: unknown, id: unknown) => makeError(Error, 'ERR_UNKNOWN_CREDENTIAL', `${String(type)} identifier does not exist: ${String(id)}`));
def('ERR_UNKNOWN_ENCODING', (encoding: unknown) => makeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${String(encoding)}`));
def('ERR_UNKNOWN_FILE_EXTENSION', (ext: unknown, path: unknown) => makeError(TypeError, 'ERR_UNKNOWN_FILE_EXTENSION', `Unknown file extension "${String(ext)}" for ${String(path)}`));
def('ERR_UNKNOWN_MODULE_FORMAT', (format: unknown, url: unknown) => makeError(RangeError, 'ERR_UNKNOWN_MODULE_FORMAT', `Unknown module format: ${String(format)} for URL ${String(url)}`));
def('ERR_UNKNOWN_SIGNAL', (signal: unknown) => makeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${String(signal)}`));
def('ERR_UNSUPPORTED_RESOLVE_REQUEST', (specifier: unknown, base: unknown) => makeError(Error, 'ERR_UNSUPPORTED_RESOLVE_REQUEST', `Unsupported request: ${String(specifier)} from ${String(base)}`));
def('ERR_USE_AFTER_CLOSE', (type: unknown) => makeError(Error, 'ERR_USE_AFTER_CLOSE', `${String(type)} was closed`));
def('ERR_VALID_PERFORMANCE_ENTRY_TYPE', () => makeError(Error, 'ERR_VALID_PERFORMANCE_ENTRY_TYPE', 'At least one valid performance entry type is required'));
def('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', () => makeError(TypeError, 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'A dynamic import callback was not specified'));
def('ERR_VM_MODULE_ALREADY_LINKED', () => makeError(Error, 'ERR_VM_MODULE_ALREADY_LINKED', 'Module has already been linked'));
def('ERR_VM_MODULE_CACHED_DATA_REJECTED', () => makeError(Error, 'ERR_VM_MODULE_CACHED_DATA_REJECTED', 'Cached data rejected for given source'));
def('ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA', () => makeError(Error, 'ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA', 'Cached data cannot be created for a module that has been evaluated'));
def('ERR_VM_MODULE_DIFFERENT_CONTEXT', () => makeError(Error, 'ERR_VM_MODULE_DIFFERENT_CONTEXT', 'Linked modules must use the same context'));
def('ERR_VM_MODULE_LINKING_ERRORED', () => makeError(Error, 'ERR_VM_MODULE_LINKING_ERRORED', 'Linking has already failed for the provided module'));
def('ERR_VM_MODULE_NOT_MODULE', () => makeError(Error, 'ERR_VM_MODULE_NOT_MODULE', 'Provided module is not an instance of Module'));
def('ERR_VM_MODULE_STATUS', (msg: unknown) => makeError(Error, 'ERR_VM_MODULE_STATUS', `Module status: ${String(msg)}`));
def('ERR_WASI_ALREADY_STARTED', () => makeError(Error, 'ERR_WASI_ALREADY_STARTED', 'WASI instance has already started'));
def('ERR_WORKER_INIT_FAILED', (msg: unknown) => makeError(Error, 'ERR_WORKER_INIT_FAILED', `Worker initialization failure: ${String(msg)}`));
def('ERR_WORKER_INVALID_EXEC_ARGV', (errors: unknown) => makeError(Error, 'ERR_WORKER_INVALID_EXEC_ARGV', `Invalid execArgv: ${String(errors)}`));
def('ERR_WORKER_NOT_RUNNING', () => makeError(Error, 'ERR_WORKER_NOT_RUNNING', 'Worker is not running'));
def('ERR_WORKER_OUT_OF_MEMORY', () => makeError(Error, 'ERR_WORKER_OUT_OF_MEMORY', 'Worker terminated due to reaching memory limit'));
def('ERR_WORKER_PATH', (path: unknown) => makeError(TypeError, 'ERR_WORKER_PATH', `The worker script or module filename must be an absolute path or relative; got ${String(path)}`));
def('ERR_WORKER_UNSERIALIZABLE_ERROR', () => makeError(Error, 'ERR_WORKER_UNSERIALIZABLE_ERROR', 'Serializing an uncaught exception failed'));
def('ERR_WORKER_UNSUPPORTED_EXTENSION', (ext: unknown) => makeError(TypeError, 'ERR_WORKER_UNSUPPORTED_EXTENSION', `${String(ext)} is not a supported script extension`));
def('ERR_WORKER_UNSUPPORTED_OPERATION', (op: unknown) => makeError(TypeError, 'ERR_WORKER_UNSUPPORTED_OPERATION', `${String(op)} is not supported in workers`));
def('ERR_ZLIB_INITIALIZATION_FAILED', () => makeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed'));

def('ERR_INVALID_ARG_TYPE_RANGE', (name: unknown, range: unknown, actual: unknown) => {
  return makeError(RangeError, 'ERR_INVALID_ARG_TYPE_RANGE', `The argument '${String(name)}' is out of range. It must be ${String(range)}. Received ${String(actual)}`);
});
def('ERR_INVALID_OBJECT_DEFINE_PROPERTY', (reason: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_OBJECT_DEFINE_PROPERTY', `Cannot define property: ${String(reason)}`);
});
def('ERR_INVALID_PERFORMANCE_MEASURE', (reason: unknown) => {
  return makeError(Error, 'ERR_INVALID_PERFORMANCE_MEASURE', `Invalid performance measure: ${String(reason)}`);
});
def('ERR_INVALID_RETURN_PROPERTY', (expected: unknown, fnName: unknown, prop: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_RETURN_PROPERTY', `Expected a valid ${String(expected)} to be returned for the "${String(prop)}" from the "${String(fnName)}" function`);
});
def('ERR_INVALID_RETURN_PROPERTY_VALUE', (expected: unknown, fnName: unknown, prop: unknown, actual: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_RETURN_PROPERTY_VALUE', `Expected ${String(expected)} to be returned for the "${String(prop)}" from the "${String(fnName)}" function but got ${tagOf(actual)}`);
});
def('ERR_INVALID_THIS_VARIANT', (actual: unknown, expected: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_THIS_VARIANT', `Value of "this" must be of type ${String(expected)}. Received ${String(actual)}`);
});
def('ERR_INVALID_TRANSFER_OBJECT', (_obj: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_TRANSFER_OBJECT', 'Found invalid object in transferList');
});
def('ERR_INVALID_IP_ADDRESS', (input: unknown) => {
  return makeError(TypeError, 'ERR_INVALID_IP_ADDRESS', `Invalid IP address: ${String(input)}`);
});

def('ERR_HTTP2_ALTSVC_LENGTH', () => makeError(TypeError, 'ERR_HTTP2_ALTSVC_LENGTH', 'HTTP/2 ALTSVC frames are limited to 16382 bytes'));
def('ERR_HTTP2_CONNECT_AUTHORITY', () => makeError(Error, 'ERR_HTTP2_CONNECT_AUTHORITY', ':authority header is required for CONNECT requests'));
def('ERR_HTTP2_CONNECT_PATH', () => makeError(Error, 'ERR_HTTP2_CONNECT_PATH', 'The :path header is forbidden for CONNECT requests'));
def('ERR_HTTP2_CONNECT_SCHEME', () => makeError(Error, 'ERR_HTTP2_CONNECT_SCHEME', 'The :scheme header is forbidden for CONNECT requests'));
def('ERR_HTTP2_ERROR', (cause: unknown) => makeError(Error, 'ERR_HTTP2_ERROR', `HTTP/2 protocol error: ${String(cause)}`));
def('ERR_HTTP2_GOAWAY_SESSION', () => makeError(Error, 'ERR_HTTP2_GOAWAY_SESSION', 'New streams cannot be created after receiving a GOAWAY'));
def('ERR_HTTP2_HEADERS_AFTER_RESPOND', () => makeError(Error, 'ERR_HTTP2_HEADERS_AFTER_RESPOND', 'Cannot specify additional headers after response initiated'));
def('ERR_HTTP2_HEADERS_SENT', () => makeError(Error, 'ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated.'));
def('ERR_HTTP2_HEADER_REQUIRED', (name: unknown) => makeError(Error, 'ERR_HTTP2_HEADER_REQUIRED', `The ${String(name)} header is required`));
def('ERR_HTTP2_HEADER_SINGLE_VALUE', (name: unknown) => makeError(TypeError, 'ERR_HTTP2_HEADER_SINGLE_VALUE', `Header field "${String(name)}" must only have a single value`));
def('ERR_HTTP2_INFO_STATUS_NOT_ALLOWED', () => makeError(RangeError, 'ERR_HTTP2_INFO_STATUS_NOT_ALLOWED', 'Informational status codes cannot be used'));
def('ERR_HTTP2_INVALID_CONNECTION_HEADERS', (name: unknown) => makeError(TypeError, 'ERR_HTTP2_INVALID_CONNECTION_HEADERS', `HTTP/1 Connection specific headers are forbidden: "${String(name)}"`));
def('ERR_HTTP2_INVALID_HEADER_VALUE', (value: unknown, name: unknown) => makeError(TypeError, 'ERR_HTTP2_INVALID_HEADER_VALUE', `Invalid value "${String(value)}" for header "${String(name)}"`));
def('ERR_HTTP2_INVALID_INFO_STATUS', (code: unknown) => makeError(RangeError, 'ERR_HTTP2_INVALID_INFO_STATUS', `Invalid informational status code: ${String(code)}`));
def('ERR_HTTP2_INVALID_ORIGIN', () => makeError(TypeError, 'ERR_HTTP2_INVALID_ORIGIN', 'HTTP/2 ORIGIN frames require a valid origin'));
def('ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', () => makeError(RangeError, 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', 'Packed settings length must be a multiple of six'));
def('ERR_HTTP2_INVALID_PSEUDOHEADER', (name: unknown) => makeError(TypeError, 'ERR_HTTP2_INVALID_PSEUDOHEADER', `"${String(name)}" is an invalid pseudoheader or is used incorrectly`));
def('ERR_HTTP2_INVALID_SESSION', () => makeError(Error, 'ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed'));
def('ERR_HTTP2_INVALID_SETTING_VALUE', (name: unknown, value: unknown) => {
  const err = makeError(TypeError, 'ERR_HTTP2_INVALID_SETTING_VALUE', `Invalid value for setting "${String(name)}": ${String(value)}`);
  (err as unknown as Record<string, unknown>)['actual'] = value;
  return err;
});
def('ERR_HTTP2_INVALID_STREAM', () => makeError(Error, 'ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed'));
def('ERR_HTTP2_MAX_PENDING_SETTINGS_ACK', () => makeError(Error, 'ERR_HTTP2_MAX_PENDING_SETTINGS_ACK', 'Maximum number of pending settings acknowledgements'));
def('ERR_HTTP2_NESTED_PUSH', () => makeError(Error, 'ERR_HTTP2_NESTED_PUSH', 'A push stream cannot initiate another push stream.'));
def('ERR_HTTP2_NO_SOCKET_MANIPULATION', () => makeError(Error, 'ERR_HTTP2_NO_SOCKET_MANIPULATION', 'HTTP/2 sockets should not be directly manipulated (e.g. read and written)'));
def('ERR_HTTP2_ORIGIN_LENGTH', () => makeError(TypeError, 'ERR_HTTP2_ORIGIN_LENGTH', 'HTTP/2 ORIGIN frames are limited to 16382 bytes'));
def('ERR_HTTP2_OUT_OF_STREAMS', () => makeError(Error, 'ERR_HTTP2_OUT_OF_STREAMS', 'No stream ID is available because maximum stream ID has been reached'));
def('ERR_HTTP2_PAYLOAD_FORBIDDEN', (code: unknown) => makeError(Error, 'ERR_HTTP2_PAYLOAD_FORBIDDEN', `Responses with ${String(code)} status must not have a payload`));
def('ERR_HTTP2_PING_CANCEL', () => makeError(Error, 'ERR_HTTP2_PING_CANCEL', 'HTTP2 ping cancelled'));
def('ERR_HTTP2_PING_LENGTH', () => makeError(RangeError, 'ERR_HTTP2_PING_LENGTH', 'HTTP2 ping payload must be 8 bytes'));
def('ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED', () => makeError(TypeError, 'ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED', 'Cannot set HTTP/2 pseudo-headers'));
def('ERR_HTTP2_PUSH_DISABLED', () => makeError(Error, 'ERR_HTTP2_PUSH_DISABLED', 'HTTP/2 client has disabled push streams'));
def('ERR_HTTP2_SEND_FILE', () => makeError(Error, 'ERR_HTTP2_SEND_FILE', 'Directories cannot be sent'));
def('ERR_HTTP2_SEND_FILE_NOSEEK', () => makeError(Error, 'ERR_HTTP2_SEND_FILE_NOSEEK', 'Offset or length can only be specified for regular files'));
def('ERR_HTTP2_SESSION_ERROR', (cause: unknown) => makeError(Error, 'ERR_HTTP2_SESSION_ERROR', `Session closed with error code ${String(cause)}`));
def('ERR_HTTP2_SETTINGS_CANCEL', () => makeError(Error, 'ERR_HTTP2_SETTINGS_CANCEL', 'HTTP2 session settings canceled'));
def('ERR_HTTP2_SOCKET_BOUND', () => makeError(Error, 'ERR_HTTP2_SOCKET_BOUND', 'The socket is already bound to an Http2Session'));
def('ERR_HTTP2_SOCKET_UNBOUND', () => makeError(Error, 'ERR_HTTP2_SOCKET_UNBOUND', 'The socket has been disconnected from the Http2Session'));
def('ERR_HTTP2_STATUS_101', () => makeError(Error, 'ERR_HTTP2_STATUS_101', 'HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2'));
def('ERR_HTTP2_STATUS_INVALID', (code: unknown) => makeError(RangeError, 'ERR_HTTP2_STATUS_INVALID', `Invalid status code: ${String(code)}`));
def('ERR_HTTP2_STREAM_CANCEL', () => makeError(Error, 'ERR_HTTP2_STREAM_CANCEL', 'The pending stream has been canceled'));
def('ERR_HTTP2_STREAM_ERROR', (code: unknown) => makeError(Error, 'ERR_HTTP2_STREAM_ERROR', `Stream closed with error code ${String(code)}`));
def('ERR_HTTP2_STREAM_SELF_DEPENDENCY', () => makeError(Error, 'ERR_HTTP2_STREAM_SELF_DEPENDENCY', 'A stream cannot depend on itself'));
def('ERR_HTTP2_TRAILERS_ALREADY_SENT', () => makeError(Error, 'ERR_HTTP2_TRAILERS_ALREADY_SENT', 'Trailing headers have already been sent'));
def('ERR_HTTP2_TRAILERS_NOT_READY', () => makeError(Error, 'ERR_HTTP2_TRAILERS_NOT_READY', 'Trailing headers cannot be sent until after the wantTrailers event is emitted'));
def('ERR_HTTP2_UNSUPPORTED_PROTOCOL', (proto: unknown) => makeError(Error, 'ERR_HTTP2_UNSUPPORTED_PROTOCOL', `protocol "${String(proto)}" is unsupported.`));

def('ERR_STREAM_WRITE_AFTER_DESTROY', () => makeError(Error, 'ERR_STREAM_WRITE_AFTER_DESTROY', 'Cannot write after stream was destroyed'));
def('ERR_STREAM_RELEASE_LOCK', () => makeError(Error, 'ERR_STREAM_RELEASE_LOCK', 'Cannot release a lock that is not held'));
def('ERR_STREAM_HAS_STRINGDECODER', () => makeError(Error, 'ERR_STREAM_HAS_STRINGDECODER', 'Stream has StringDecoder'));
def('ERR_MULTIPLE_RESOLVES', (type: unknown, state: unknown, value: unknown) => {
  return makeError(Error, 'ERR_MULTIPLE_RESOLVES', `Promise was ${String(state)} with ${String(value)} but a previous ${String(type)} already resolved`);
});
def('ERR_QUEUE_FULL', () => makeError(Error, 'ERR_QUEUE_FULL', 'Queue is full'));
def('ERR_QUEUE_CLOSED', () => makeError(Error, 'ERR_QUEUE_CLOSED', 'Queue is closed'));

def('ERR_CRYPTO_INVALID_KEY', () => makeError(Error, 'ERR_CRYPTO_INVALID_KEY', 'Invalid key'));
def('ERR_CRYPTO_INVALID_MESSAGELEN', () => makeError(RangeError, 'ERR_CRYPTO_INVALID_MESSAGELEN', 'Invalid message length'));
def('ERR_CRYPTO_OPERATION_FAILED', (op: unknown) => makeError(Error, 'ERR_CRYPTO_OPERATION_FAILED', `Crypto operation failed: ${String(op)}`));
def('ERR_CRYPTO_INVALID_KEYTYPE', (actual: unknown, expected: unknown) => {
  return makeError(TypeError, 'ERR_CRYPTO_INVALID_KEYTYPE', `Invalid key object type ${String(actual)}, expected ${String(expected)}.`);
});
def('ERR_CRYPTO_INCOMPATIBLE_KEY', (name: unknown, msg: unknown) => {
  return makeError(Error, 'ERR_CRYPTO_INCOMPATIBLE_KEY', `Incompatible ${String(name)}: ${String(msg)}`);
});
def('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', (name: unknown, msg: unknown) => {
  return makeError(Error, 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', `The selected key encoding ${String(name)} ${String(msg)}.`);
});
def('ERR_TLS_PSK_SET_IDENTIY_HINT_FAILED', () => makeError(Error, 'ERR_TLS_PSK_SET_IDENTIY_HINT_FAILED', 'Failed to set PSK identity hint'));
def('ERR_TLS_ALPN_CALLBACK_INVALID_RESULT', (result: unknown, protocols: unknown) => {
  return makeError(TypeError, 'ERR_TLS_ALPN_CALLBACK_INVALID_RESULT', `ALPN callback returned a value (${String(result)}) that did not match any of the client's offered protocols (${JSON.stringify(protocols)})`);
});

def('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', (specifier: unknown, type: unknown) => {
  return makeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${String(specifier)}" is not of type "${String(type)}"`);
});
def('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', (key: unknown, value: unknown) => {
  return makeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "${String(key)}" with value "${String(value)}" is not supported`);
});
def('ERR_IMPORT_ASSERTION_TYPE_FAILED', (specifier: unknown, type: unknown) => {
  return makeError(TypeError, 'ERR_IMPORT_ASSERTION_TYPE_FAILED', `Module "${String(specifier)}" is not of type "${String(type)}"`);
});
def('ERR_IMPORT_ASSERTION_TYPE_MISSING', (specifier: unknown, type: unknown) => {
  return makeError(TypeError, 'ERR_IMPORT_ASSERTION_TYPE_MISSING', `Module "${String(specifier)}" needs an import assertion of type "${String(type)}"`);
});
def('ERR_IMPORT_ASSERTION_TYPE_UNSUPPORTED', (type: unknown) => {
  return makeError(TypeError, 'ERR_IMPORT_ASSERTION_TYPE_UNSUPPORTED', `Import assertion type "${String(type)}" is unsupported`);
});
def('ERR_MODULE_NOT_FOUND_PACKAGE_PATH', (path: unknown, base: unknown) => {
  return makeError(Error, 'ERR_MODULE_NOT_FOUND_PACKAGE_PATH', `Cannot find package path '${String(path)}' imported from ${String(base)}`);
});
def('ERR_VM_MODULE_NOT_LINKED', () => makeError(Error, 'ERR_VM_MODULE_NOT_LINKED', 'Module must be linked before evaluation'));
def('ERR_MANIFEST_ASSERT_INTEGRITY', (moduleURL: unknown, realIntegrities: unknown) => {
  return makeError(Error, 'ERR_MANIFEST_ASSERT_INTEGRITY', `Manifest resource ${String(moduleURL)} has no matching integrity in manifest (${String(realIntegrities)})`);
});

def('ERR_FS_RMDIR_ENOTDIR', (path: unknown) => {
  const err = makeError(Error, 'ERR_FS_RMDIR_ENOTDIR', `Path is not a directory: ${String(path)}`);
  (err as unknown as Record<string, unknown>)['syscall'] = 'rmdir';
  (err as unknown as Record<string, unknown>)['path'] = path;
  return err;
});
def('ERR_FS_INVALID_OPTIONS', (reason: unknown) => makeError(TypeError, 'ERR_FS_INVALID_OPTIONS', `Invalid options: ${String(reason)}`));
def('ERR_FS_INVALID_DIR_HANDLE', () => makeError(Error, 'ERR_FS_INVALID_DIR_HANDLE', 'Directory handle is invalid'));
def('ERR_FS_CHANGED_HANDLE', () => makeError(Error, 'ERR_FS_CHANGED_HANDLE', 'File handle has been changed'));
def('ERR_FS_WATCHER_ALREADY_STARTED', () => makeError(Error, 'ERR_FS_WATCHER_ALREADY_STARTED', 'The watcher has already been started'));

def('ERR_WORKER_MESSAGING_ERRORED', () => makeError(Error, 'ERR_WORKER_MESSAGING_ERRORED', 'The destination thread threw an error while processing the message'));
def('ERR_WORKER_MESSAGING_FAILED', () => makeError(Error, 'ERR_WORKER_MESSAGING_FAILED', 'Sending a message to another thread failed'));
def('ERR_WORKER_MESSAGING_SAME_THREAD', () => makeError(Error, 'ERR_WORKER_MESSAGING_SAME_THREAD', 'Cannot send a message to the same thread'));
def('ERR_WORKER_MESSAGING_TIMEOUT', () => makeError(Error, 'ERR_WORKER_MESSAGING_TIMEOUT', 'Sending a message to another thread timed out'));
def('ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE', () => makeError(Error, 'ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE', 'Target context is unavailable'));
def('ERR_CLOSED_MESSAGE_PORT', () => makeError(Error, 'ERR_CLOSED_MESSAGE_PORT', 'Cannot send data on closed MessagePort'));
def('ERR_IPC_ONE_PIPE', () => makeError(Error, 'ERR_IPC_ONE_PIPE', 'Child process can have only one IPC pipe'));
def('ERR_IPC_SYNC_FORK', () => makeError(Error, 'ERR_IPC_SYNC_FORK', 'IPC cannot be used with synchronous forks'));

def('ERR_NET_INVALID_HOSTNAME', (host: unknown) => makeError(TypeError, 'ERR_NET_INVALID_HOSTNAME', `Invalid hostname: ${String(host)}`));
def('ERR_DNS_INVALID_HOSTNAME', (host: unknown) => makeError(TypeError, 'ERR_DNS_INVALID_HOSTNAME', `Invalid hostname: ${String(host)}`));
def('ERR_SOCKET_BAD_BUFFER_SIZE', () => makeError(TypeError, 'ERR_SOCKET_BAD_BUFFER_SIZE', 'Buffer size must be a positive integer'));
def('ERR_SOCKET_BAD_FAMILY', (family: unknown) => makeError(RangeError, 'ERR_SOCKET_BAD_FAMILY', `Bad address family: ${String(family)}`));
def('ERR_SOCKET_BAD_ADDRESS', (addr: unknown) => makeError(Error, 'ERR_SOCKET_BAD_ADDRESS', `Bad socket address: ${String(addr)}`));

def('ERR_OUT_OF_RANGE_STDIO', (name: unknown, range: unknown, actual: unknown) => {
  return makeError(RangeError, 'ERR_OUT_OF_RANGE_STDIO', `stdio[${String(name)}] is out of range. It must be ${String(range)}. Received ${String(actual)}`);
});
def('ERR_CHILD_PROCESS_FORK_OPTIONS', (reason: unknown) => makeError(TypeError, 'ERR_CHILD_PROCESS_FORK_OPTIONS', `Invalid fork options: ${String(reason)}`));
def('ERR_CHILD_PROCESS_FAILED', (op: unknown, code: unknown) => makeError(Error, 'ERR_CHILD_PROCESS_FAILED', `Child process ${String(op)} failed with code ${String(code)}`));
def('ERR_INVALID_STDIO_TYPE', (actual: unknown) => makeError(TypeError, 'ERR_INVALID_STDIO_TYPE', `Invalid stdio type: ${tagOf(actual)}`));
def('ERR_PROCESS_KILL_FAILED', (pid: unknown, signal: unknown) => {
  const err = makeError(Error, 'ERR_PROCESS_KILL_FAILED', `Failed to send signal ${String(signal)} to process ${String(pid)}`);
  (err as unknown as Record<string, unknown>)['pid'] = pid;
  (err as unknown as Record<string, unknown>)['signal'] = signal;
  return err;
});

def('ERR_BROTLI_INVALID_PARAM', (param: unknown) => makeError(RangeError, 'ERR_BROTLI_INVALID_PARAM', `${String(param)} is not a valid Brotli parameter`));
def('ERR_BROTLI_COMPRESSION_FAILED', () => makeError(Error, 'ERR_BROTLI_COMPRESSION_FAILED', 'Brotli compression failed'));
def('ERR_ZLIB_BINDING_CLOSED', () => makeError(Error, 'ERR_ZLIB_BINDING_CLOSED', 'zlib binding closed'));
def('ERR_ZLIB_OPERATION_FAILED', (op: unknown) => makeError(Error, 'ERR_ZLIB_OPERATION_FAILED', `zlib operation failed: ${String(op)}`));
def('ERR_PERFORMANCE_INVALID_TIMESTAMP', (ts: unknown) => makeError(TypeError, 'ERR_PERFORMANCE_INVALID_TIMESTAMP', `${String(ts)} is not a valid timestamp`));
def('ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS', (reason: unknown) => makeError(TypeError, 'ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS', `Invalid performance measure options: ${String(reason)}`));
def('ERR_REPL_EVAL_CONFIG', () => makeError(Error, 'ERR_REPL_EVAL_CONFIG', 'Cannot specify both "breakEvalOnSigint" and "eval" for REPL'));
def('ERR_REPL_INPUT_TOO_LONG', () => makeError(RangeError, 'ERR_REPL_INPUT_TOO_LONG', 'REPL input is too long'));
def('ERR_TEST_TIMEOUT', (ms: unknown) => makeError(Error, 'ERR_TEST_TIMEOUT', `Test timed out after ${String(ms)}ms`));
def('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG', () => makeError(TypeError, 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG', 'A dynamic import callback was invoked without --experimental-vm-modules'));
def('ERR_SOURCE_MAP_CANNOT_LOAD', (url: unknown, reason: unknown) => makeError(Error, 'ERR_SOURCE_MAP_CANNOT_LOAD', `Cannot load source map for ${String(url)}: ${String(reason)}`));
def('ERR_SOURCE_MAP_MISSING_SOURCE', (source: unknown, mapURL: unknown) => makeError(Error, 'ERR_SOURCE_MAP_MISSING_SOURCE', `Cannot find '${String(source)}' imported from the source map for ${String(mapURL)}`));

export const codes: Readonly<Record<string, ErrorFactory>> = Object.freeze({ ...codes_ });

export const isNodeError = (err: unknown, code?: string): err is Error & { code: string } => {
  if (!(err instanceof Error)) return false;
  const c = (err as unknown as Record<string, unknown>)['code'];
  if (typeof c !== 'string') return false;
  if (code) return c === code;
  return c.startsWith('ERR_') || /^E[A-Z]+$/.test(c);
};

export const getErrorMessage = (code: string, ...args: unknown[]): string => {
  const factory = codes_[code];
  if (!factory) return code;
  return factory(...args).message;
};

export const errnoError = (
  errno: string,
  syscall: string,
  path?: string,
  customMessage?: string,
): Error => {
  const baseMsg = customMessage ?? `${errno}: ${pathMessage(errno, syscall, path)}`;
  const err = new Error(baseMsg);
  const r = err as unknown as Record<string, unknown>;
  r['code'] = errno;
  r['syscall'] = syscall;
  if (path !== undefined) r['path'] = path;
  return err;
};

const pathMessage = (errno: string, syscall: string, path?: string): string => {
  const desc = errnoDescription(errno);
  if (path !== undefined) return `${desc}, ${syscall} '${path}'`;
  return desc;
};

const errnoDescription = (errno: string): string => {
  switch (errno) {
    case 'ENOENT': return 'no such file or directory';
    case 'EACCES': return 'permission denied';
    case 'EEXIST': return 'file already exists';
    case 'EISDIR': return 'illegal operation on a directory';
    case 'ENOTDIR': return 'not a directory';
    case 'ENOTEMPTY': return 'directory not empty';
    case 'EBUSY': return 'resource busy or locked';
    case 'EROFS': return 'read-only file system';
    case 'EBADF': return 'bad file descriptor';
    case 'EMFILE': return 'too many open files';
    case 'EPERM': return 'operation not permitted';
    case 'EINVAL': return 'invalid argument';
    case 'ENOSPC': return 'no space left on device';
    case 'EPIPE': return 'broken pipe';
    case 'EXDEV': return 'cross-device link not permitted';
    case 'ELOOP': return 'too many symbolic links encountered';
    case 'ECONNREFUSED': return 'connection refused';
    case 'ECONNRESET': return 'connection reset by peer';
    case 'ETIMEDOUT': return 'operation timed out';
    case 'EADDRINUSE': return 'address already in use';
    default: return errno;
  }
};
