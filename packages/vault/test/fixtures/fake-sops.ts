// A stand-in for `sops --decrypt --extract '["name"]' <file>`: the "encrypted"
// file is plain JSON with fake values. Special names: `env` prints the names of
// the variables it received, `fail` writes to stderr and exits 1, `hang` never answers.
import { readFileSync } from 'node:fs';

const [decrypt, extract, path, file] = process.argv.slice(2);
if (decrypt !== '--decrypt' || extract !== '--extract' || path === undefined || file === undefined) {
  process.stderr.write('unexpected arguments\n');
  process.exit(2);
}
const name = /^\["(.+)"\]$/.exec(path)?.[1];

if (name === 'env') {
  process.stdout.write(`${JSON.stringify(Object.keys(process.env).sort())}\n`);
} else if (name === 'fail') {
  process.stderr.write('fake-stderr-must-not-leak\n');
  process.exit(1);
} else if (name === 'hang') {
  setInterval(() => undefined, 1000);
} else {
  const values = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  const value = name === undefined ? undefined : values[name];
  if (value === undefined) {
    process.stderr.write('component not found\n');
    process.exit(1);
  }
  process.stdout.write(`${value}\n`);
}
