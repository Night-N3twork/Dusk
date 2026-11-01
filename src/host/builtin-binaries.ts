export const BUILTIN_BINARIES: Record<string, string> = {
  '/bin/true': '',
  '/bin/false': 'process.exit(1);',
  '/bin/echo': "(function(){ var args = process.argv.slice(1); var i = 0; var newline = true; if (args[0] === '-n') { newline = false; i = 1; } var msg = args.slice(i).join(' '); if (newline) msg += '\\n'; process.stdout.write(msg); })();",
  '/bin/pwd': 'process.stdout.write(process.cwd() + "\\n");',
  '/bin/env': "(function(){ var keys = Object.keys(process.env); for (var i = 0; i < keys.length; i++) process.stdout.write(keys[i] + '=' + process.env[keys[i]] + '\\n'); })();",
  // whoami: print USER env, defaulting to 'dusk'.
  '/bin/whoami': "process.stdout.write((process.env.USER || 'dusk') + '\\n');",
  // hostname: print /etc/hostname content or 'duskjs'.
  '/bin/hostname': "(function(){ try { var h = __fs.readFile('/etc/hostname'); process.stdout.write(h.replace(/\\n+$/, '') + '\\n'); } catch (e) { process.stdout.write('duskjs\\n'); } })();",
  // clear: emit ANSI clear-screen (works on real terminals; harmless in <pre>).
  '/bin/clear': 'process.stdout.write("\\x1b[2J\\x1b[H");',
  // curl: focused HTTP client backed by globalThis.fetch, which world/net.ts
  // routes through the configured Nova LibCurl. Deliberately reject flags
  // outside this contract rather than silently claiming curl compatibility.
  '/bin/curl': "#!/bin/node\n(async function(){\n" +
    "  // When routed through /bin/node, process.argv = ['node', scriptPath, ...userArgs].\n" +
    "  // slice(2) skips both to get only the user args.\n" +
    "  var argv = process.argv.slice(2);\n" +
    "  if (argv.length === 0) { process.stderr.write('curl: try \\'curl --help\\' for more information\\n'); process.exit(2); }\n" +
    "  if (argv[0] === '--help' || argv[0] === '-h') {\n" +
    "    process.stdout.write('Usage: curl [options] <url>\\n  -X, --request METHOD    HTTP method (default GET)\\n  -H, --header \\'K: V\\'   Add request header (repeatable)\\n  -d, --data BODY         Request body (sets method to POST unless -X used)\\n  -o, --output FILE       Write output to FILE instead of stdout\\n  -s, --silent            Suppress informational diagnostics\\n  -i, --include           Include response headers in output\\n  -L, --location          Follow redirects (off by default)\\n  -v, --verbose           Verbose logging to stderr\\n  --url URL               Explicit URL flag\\n');\n" +
    "    return;\n" +
    "  }\n" +
    "  var url = null; var method = null; var headers = {}; var body = null;\n" +
    "  var outFile = null; var silent = false; var include = false; var verbose = false; var location = false;\n" +
    "  function optionValue(flag) { if (i + 1 >= argv.length) { process.stderr.write('curl: option requires an argument: ' + flag + '\\n'); process.exit(2); return null; } return argv[++i]; }\n" +
    "  for (var i = 0; i < argv.length; i++) {\n" +
    "    var a = argv[i];\n" +
    "    if (a === '-X' || a === '--request') { method = optionValue(a); if (method === null) return; }\n" +
    "    else if (a === '-H' || a === '--header') {\n" +
    "      var h = optionValue(a); if (h === null) return; var idx = h.indexOf(':');\n" +
    "      if (idx <= 0) { process.stderr.write('curl: invalid header: ' + h + '\\n'); process.exit(2); return; } headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();\n" +
    "    }\n" +
    "    else if (a === '-d' || a === '--data' || a === '--data-raw') { body = optionValue(a); if (body === null) return; if (!method) method = 'POST'; }\n" +
    "    else if (a === '-o' || a === '--output') { outFile = optionValue(a); if (outFile === null) return; }\n" +
    "    else if (a === '-s' || a === '--silent') { silent = true; }\n" +
    "    else if (a === '-i' || a === '--include') { include = true; }\n" +
    "    else if (a === '-v' || a === '--verbose') { verbose = true; }\n" +
    "    else if (a === '-L' || a === '--location') { location = true; }\n" +
    "    else if (a === '--url') { url = optionValue(a); if (url === null) return; }\n" +
    "    else if (a && a.charAt(0) !== '-') { url = a; }\n" +
    "    else if (a && a.charAt(0) === '-') { process.stderr.write('curl: unsupported option: ' + a + '\\n'); process.exit(2); return; }\n" +
    "  }\n" +
    "  if (!url) { process.stderr.write('curl: no URL specified\\n'); process.exit(2); }\n" +
    "  if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;\n" +
    "  if (verbose) process.stderr.write('* ' + (method || 'GET') + ' ' + url + '\\n');\n" +
    "  try {\n" +
    "    var opts = { method: method || 'GET', headers: headers, redirect: location ? 'follow' : 'manual' };\n" +
    "    if (body != null) opts.body = body;\n" +
    "    var res = await fetch(url, opts);\n" +
    "    var header = '';\n" +
    "    if (verbose || include) {\n" +
    "      var statusLine = 'HTTP/1.1 ' + res.status + ' ' + (res.statusText || '');\n" +
    "      if (verbose) process.stderr.write('< ' + statusLine + '\\n');\n" +
    "      if (include) header += statusLine + '\\r\\n';\n" +
    "      if (res.headers && typeof res.headers.forEach === 'function') {\n" +
    "        res.headers.forEach(function(v, k) {\n" +
    "          var line = k + ': ' + v;\n" +
    "          if (verbose) process.stderr.write('< ' + line + '\\n');\n" +
    "          if (include) header += line + '\\r\\n';\n" +
    "        });\n" +
    "      }\n" +
    "      if (include) header += '\\r\\n';\n" +
    "    }\n" +
    "    var bodyBytes = new Uint8Array(await res.arrayBuffer()); var headerBytes = new TextEncoder().encode(header); var output = new Uint8Array(headerBytes.length + bodyBytes.length); output.set(headerBytes); output.set(bodyBytes, headerBytes.length);\n" +
    "    if (outFile) { require('fs').writeFileSync(outFile, output); if (!silent) process.stderr.write('curl: wrote ' + output.length + ' bytes to ' + outFile + '\\n'); }\n" +
    "    else { ipc.send({ f: 'proc.write', fd: 1, data: Array.from(output) }); }\n" +
    "    if (!res.ok && !include && !silent) process.stderr.write('curl: HTTP ' + res.status + ' ' + (res.statusText || '') + '\\n');\n" +
    "    process.exit(res.ok ? 0 : (res.status >= 400 ? 22 : 0));\n" +
    "  } catch (e) {\n" +
    "    var detail = (e && e.message) || String(e); var lower = String(detail).toLowerCase(); var category = lower.indexOf('dns') >= 0 || lower.indexOf('getaddrinfo') >= 0 || lower.indexOf('enotfound') >= 0 ? 'DNS' : lower.indexOf('timeout') >= 0 || lower.indexOf('timed out') >= 0 ? 'timeout' : lower.indexOf('tls') >= 0 || lower.indexOf('ssl') >= 0 || lower.indexOf('certificate') >= 0 ? 'TLS' : lower.indexOf('connect') >= 0 || lower.indexOf('refused') >= 0 || lower.indexOf('econn') >= 0 ? 'connect' : lower.indexOf('unavailable') >= 0 || lower.indexOf('not supported') >= 0 ? 'unavailable' : 'transport';\n" +
    "    process.stderr.write('curl: (' + category + ') ' + detail + '\\n');\n" +
    "    process.exit(6);\n" +
    "  }\n" +
    "})();",
  // wget: minimal alias — behaves like `curl -sL -o <file>` when given -O,
  // else writes body to a filename derived from the URL path. Supports:
  // -O FILE (explicit output), -q (quiet), and positional URL.
  '/bin/wget': "#!/bin/node\n(async function(){\n" +
    "  // Derive args from argv0 rather than a fixed slice(2): a direct spawn\n" +
    "  // gives ['/bin/wget', ...] while a shebang route gives ['node',\n" +
    "  // '/bin/wget', ...], so slice(2) ate the first real arg when spawned\n" +
    "  // directly.\n" +
    "  var raw = process.argv || [];\n" +
    "  var start = 0;\n" +
    "  for (var k = 0; k < raw.length; k++) { if (/wget$/.test(String(raw[k]))) { start = k + 1; break; } }\n" +
    "  var argv = raw.slice(start);\n" +
    "  // process.exit() does not unwind the calling frame in this runtime, so\n" +
    "  // every exit path must return as well (same shape as /bin/curl).\n" +
    "  if (argv.length === 0) {\n" +
    "    process.stdout.write('Usage: wget [-q] [-O FILE] <url>\\n'); process.exit(1); return;\n" +
    "  }\n" +
    "  if (argv[0] === '--help' || argv[0] === '-h') {\n" +
    "    process.stdout.write('Usage: wget [-q] [-O FILE] <url>\\n'); return;\n" +
    "  }\n" +
    "  var url = null; var outFile = null; var quiet = false;\n" +
    "  for (var i = 0; i < argv.length; i++) {\n" +
    "    var a = argv[i];\n" +
    "    if (a === '-O' || a === '--output-document') outFile = argv[++i];\n" +
    "    else if (a === '-q' || a === '--quiet') quiet = true;\n" +
    "    else if (a && a.charAt(0) !== '-') url = a;\n" +
    "  }\n" +
    "  if (!url) { process.stderr.write('wget: missing URL\\n'); process.exit(1); }\n" +
    "  if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;\n" +
    "  if (!outFile) {\n" +
    "    var m = /\\/([^\\/?#]+)(?:[?#]|$)/.exec(url);\n" +
    "    outFile = (m && m[1]) ? m[1] : 'index.html';\n" +
    "  }\n" +
    "  try {\n" +
    "    var res = await fetch(url);\n" +
    "    var bytes = new Uint8Array(await res.arrayBuffer());\n" +
    "    require('fs').writeFileSync(outFile, bytes);\n" +
    "    if (!quiet) process.stderr.write(\"'\" + outFile + \"' saved [\" + bytes.length + \" bytes]\\n\");\n" +
    "    process.exit(res.ok ? 0 : 8);\n" +
    "  } catch (e) {\n" +
    "    process.stderr.write('wget: ' + ((e && e.message) || String(e)) + '\\n');\n" +
    "    process.exit(4);\n" +
    "  }\n" +
    "})();",
};

// Just-bash commands: thin wrappers that shell out to /bin/dsh so users can
// invoke `grep`, `sed`, `awk`, etc. directly at a shell prompt without the
// `dsh -c "..."` incantation.
//
// Two dispatch paths exist:
//
//   1. Elision (fast path): the ProcessManager checks JSH_COMMAND_SET before
//      spawning and, if the command is in the set, rewrites the spawn to
//      `/bin/dsh -c '<name> <args>'` directly. This saves a whole
//      SpiderMonkey Worker (~100MB) per invocation by avoiding the
//      intermediate JSH-wrapper process. See process-manager.ts spawn().
//
//   2. Fallback wrapper (slow path): if the elision was bypassed for any
//      reason and /bin/grep etc. are actually spawned, this in-engine
//      wrapper reads stdin then spawnSync('/bin/dsh', ['-c', script])s
//      inside its own worker. Kept as a safety net; every current call
//      site goes through the fast path.
export const JSH_COMMANDS = [
  // Text processing
  'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'cut', 'paste',
  'tac', 'tr', 'tee', 'fold', 'expand', 'nl', 'rev', 'od',
  'strings', 'column', 'comm', 'diff', 'join', 'split',
  // File/directory ops
  'cat', 'ls', 'mkdir', 'rm', 'touch', 'cp', 'mv', 'find', 'xargs', 'chmod', 'ln', 'du', 'stat', 'readlink', 'rmdir',
  // Data formats / hashing
  'jq', 'yq', 'base64', 'md5sum', 'printf', 'expr', 'date', 'file', 'which', 'tree',
  'tar', 'gzip', 'gunzip', 'zcat', 'zip', 'unzip', 'patch', 'less', 'more', 'nano', 'vi', 'vim',
  // JS execution (routes to /bin/node inside dsh)
  'js-exec', 'js',
  // Utils
  'head', 'tail', 'wc', 'seq', 'sleep', 'basename', 'dirname', 'timeout',
];

// The wrapper source: read argv (excluding argv[0]), quote each arg for shell,
// then invoke `/bin/dsh -c 'name arg1 arg2 ...'`. Forward stdin bytes as
// process.stdin content so pipelines work.
const buildJshWrapper = (cmdName: string): string => {
  return "(function(){\n"
    + "  var argv = (process.argv || []).slice(1);\n"
    + "  var qArgs = argv.map(function(a){ return \"'\" + String(a).replace(/'/g, \"'\\\\''\") + \"'\"; });\n"
    + "  var script = " + JSON.stringify(cmdName) + " + (qArgs.length ? ' ' + qArgs.join(' ') : '');\n"
    + "  var stdinChunks = [];\n"
    + "  var stdinLength = 0;\n"
    + "  while (true) {\n"
    + "    var r = ipc.send({ f: 'proc.readStdin', wait: true });\n"
    + "    if (!r || r.value === null || r.value === undefined || r.signal) break;\n"
    + "    if (r.value.length > 0) { stdinChunks.push(new Uint8Array(r.value)); stdinLength += r.value.length; }\n"
    + "  }\n"
    + "  var stdinBytes = new Uint8Array(stdinLength);\n"
    + "  for (var c = 0, o = 0; c < stdinChunks.length; o += stdinChunks[c].length, c++) stdinBytes.set(stdinChunks[c], o);\n"
    + "  var cp = require('node:child_process');\n"
    + "  var opts = { cwd: process.cwd() };\n"
    + "  if (stdinBytes.length > 0) opts.stdin = new Uint8Array(stdinBytes);\n"
    + "  var r = cp.spawnSync('/bin/dsh', ['-c', script], opts);\n"
    + "  if (r.stdout && r.stdout.length) process.stdout.write(r.stdout);\n"
    + "  if (r.stderr && r.stderr.length) process.stderr.write(r.stderr);\n"
    + "  process.exit(r.status || 0);\n"
    + "})();";
};

// Fast-path set: names in this set get their /bin/<name> spawn rewritten
// to /bin/dsh -c '<name> ...' by ProcessManager. Excludes any name that
// happens to also be a native builtin (checked below).
export const JSH_COMMAND_SET: Set<string> = new Set(
  JSH_COMMANDS
    .map((n) => '/bin/' + n)
    .filter((k) => !Object.prototype.hasOwnProperty.call(BUILTIN_BINARIES, k)),
);

for (const name of JSH_COMMANDS) {
  const key = '/bin/' + name;
  // Don't overwrite in-engine builtins registered above. If we already have
  // a fast native implementation for this command, keep it.
  if (Object.prototype.hasOwnProperty.call(BUILTIN_BINARIES, key)) continue;
  BUILTIN_BINARIES[key] = buildJshWrapper(name);
}
