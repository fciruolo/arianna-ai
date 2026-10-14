import { join } from 'node:path';

/**
 * Where apps/guard lives on disk (D-113): the second scanner of personal data,
 * a Python environment of its own like apps/voice, everything inside ARIANNA_HOME.
 */
export interface GuardPaths {
  /** The Python sources, run with PYTHONPATH. */
  src: string;
  /** The uv project: pyproject.toml and uv.lock. */
  project: string;
  /** The environment `uv sync` builds, and its interpreter. */
  venv: string;
  python: string;
  /** Python installs and download cache of uv. */
  uvPython: string;
  uvCache: string;
  /** Private scratch files: the caches of torch and transformers stay here. */
  tmp: string;
  /** The models of the catalog with `dir: guard` (D-203): data/guard/models/<id>, never read by oMLX. */
  models: string;
  /** Reports of the trial on invented sentences. */
  evals: string;
}

export function guardPaths(home: string, data: string): GuardPaths {
  const root = join(data, 'guard');
  const venv = join(root, 'venv');
  return {
    src: join(home, 'apps', 'guard', 'src'),
    project: join(home, 'apps', 'guard'),
    venv,
    python: join(venv, 'bin', 'python'),
    uvPython: join(root, 'python'),
    uvCache: join(root, 'cache'),
    tmp: join(root, 'tmp'),
    models: join(root, 'models'),
    evals: join(data, 'evals'),
  };
}
