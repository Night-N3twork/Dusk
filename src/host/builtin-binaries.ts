export const BUILTIN_BINARIES: Record<string, string> = {
  '/bin/true': '',
  '/bin/false': 'process.exit(1);',
  '/bin/echo': "(function(){ var args = process.argv.slice(1); var i = 0; var newline = true; if (args[0] === '-n') { newline = false; i = 1; } var msg = args.slice(i).join(' '); if (newline) msg += '\\n'; process.stdout.write(msg); })();",
  '/bin/pwd': 'process.stdout.write(process.cwd() + "\\n");',
  '/bin/cat': "(function(){ var files = process.argv.slice(1); if (files.length === 0) { while (true) { var r = ipc.send({ f: 'proc.readStdin' }); if (r.value === null) break; if (r.value && r.value.length) process.stdout.write(new Uint8Array(r.value)); else { var deadline = Date.now() + 10; while (Date.now() < deadline) {} } } } else { for (var i = 0; i < files.length; i++) { try { process.stdout.write(__fs.readFile(files[i])); } catch (e) { process.stderr.write('cat: ' + files[i] + ': ' + e + '\\n'); process.exit(1); } } } })();",
  '/bin/env': "(function(){ var keys = Object.keys(process.env); for (var i = 0; i < keys.length; i++) process.stdout.write(keys[i] + '=' + process.env[keys[i]] + '\\n'); })();",
  // ls: minimal — accepts flags -l -a (mostly ignored), and one or more paths (defaults to cwd).
  // Prints one entry per line. -l uses the same 1/entry format (no columns yet).
  // -a shows dotfiles. Errors go to stderr with exit 1 on any bad path.
  '/bin/ls': "(function(){ var args = process.argv.slice(1); var showHidden = false; var paths = []; for (var i = 0; i < args.length; i++) { var a = args[i]; if (a === '-a' || a === '-la' || a === '-al') showHidden = true; else if (a && a.charAt(0) === '-') { /* other flags ignored for now */ } else paths.push(a); } if (paths.length === 0) paths = [process.cwd()]; var bad = false; for (var j = 0; j < paths.length; j++) { var p = paths[j]; try { var entries = __fs.readdir(p); if (paths.length > 1) process.stdout.write(p + ':\\n'); for (var k = 0; k < entries.length; k++) { var name = entries[k]; if (!showHidden && name && name.charAt(0) === '.') continue; process.stdout.write(name + '\\n'); } if (paths.length > 1 && j < paths.length - 1) process.stdout.write('\\n'); } catch (e) { process.stderr.write('ls: ' + p + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // mkdir: creates directory. -p makes parents.
  '/bin/mkdir': "(function(){ var args = process.argv.slice(1); var recursive = false; var paths = []; for (var i = 0; i < args.length; i++) { var a = args[i]; if (a === '-p') recursive = true; else if (a && a.charAt(0) === '-') { /* ignore */ } else paths.push(a); } if (paths.length === 0) { process.stderr.write('mkdir: missing operand\\n'); process.exit(1); } var bad = false; for (var j = 0; j < paths.length; j++) { try { __fs.mkdir(paths[j], recursive); } catch (e) { process.stderr.write('mkdir: ' + paths[j] + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // rm: deletes file or directory. -r/-rf recursive.
  '/bin/rm': "(function(){ var args = process.argv.slice(1); var paths = []; for (var i = 0; i < args.length; i++) { var a = args[i]; if (a && a.charAt(0) === '-') { /* flags ignored — always attempts rm */ } else paths.push(a); } if (paths.length === 0) { process.stderr.write('rm: missing operand\\n'); process.exit(1); } var bad = false; for (var j = 0; j < paths.length; j++) { try { __fs.rm(paths[j]); } catch (e) { process.stderr.write('rm: ' + paths[j] + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // touch: creates empty file if missing (existing files get their content preserved).
  '/bin/touch': "(function(){ var args = process.argv.slice(1); if (args.length === 0) { process.stderr.write('touch: missing operand\\n'); process.exit(1); } var bad = false; for (var i = 0; i < args.length; i++) { try { if (!__fs.exists(args[i])) __fs.writeFile(args[i], ''); } catch (e) { process.stderr.write('touch: ' + args[i] + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // whoami: print USER env, defaulting to 'dusk'.
  '/bin/whoami': "process.stdout.write((process.env.USER || 'dusk') + '\\n');",
  // hostname: print /etc/hostname content or 'duskjs'.
  '/bin/hostname': "(function(){ try { var h = __fs.readFile('/etc/hostname'); process.stdout.write(h.replace(/\\n+$/, '') + '\\n'); } catch (e) { process.stdout.write('duskjs\\n'); } })();",
  // clear: emit ANSI clear-screen (works on real terminals; harmless in <pre>).
  '/bin/clear': 'process.stdout.write("\\x1b[2J\\x1b[H");',
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
  'cp', 'mv', 'find', 'xargs', 'chmod', 'ln', 'du', 'stat', 'readlink', 'rmdir',
  // Data formats / hashing
  'jq', 'yq', 'base64', 'md5sum', 'printf', 'expr', 'date', 'file', 'which', 'tree',
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
    + "  // Read all of stdin. Loop until we see a null (EOF) response from\n"
    + "  // the host, OR we see two consecutive empty-array responses (no more\n"
    + "  // data buffered and stdin isn't closing on its own). Track empties\n"
    + "  // instead of a Date.now() spin, which is unreliable under the fake\n"
    + "  // engine timer.\n"
    + "  var stdinBytes = [];\n"
    + "  var emptyStreak = 0;\n"
    + "  while (emptyStreak < 2) {\n"
    + "    var r = ipc.send({ f: 'proc.readStdin' });\n"
    + "    if (!r || r.value === null) break;\n"
    + "    if (r.value && r.value.length > 0) {\n"
    + "      for (var i = 0; i < r.value.length; i++) stdinBytes.push(r.value[i]);\n"
    + "      emptyStreak = 0;\n"
    + "    } else {\n"
    + "      emptyStreak++;\n"
    + "    }\n"
    + "  }\n"
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
