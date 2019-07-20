// @flow
import type {
  FilePath,
  ParcelConfigFile,
  ResolvedParcelConfigFile,
  PackageName,
  ParcelOptions
} from '@parcel/types';
import type {FileSystem} from '@parcel/fs';
import {resolveConfig} from '@parcel/utils';
import {parse} from 'json5';
import path from 'path';
import {localResolve} from '@parcel/local-require';
import assert from 'assert';

import ParcelConfig from './ParcelConfig';

type Pipeline = Array<PackageName>;
type ConfigMap<K, V> = {[K]: V};

export default async function loadParcelConfig(
  filePath: FilePath,
  options: ParcelOptions
) {
  let fs = options.inputFS;
  // Resolve plugins from cwd when a config is passed programmatically
  let parcelConfig = options.config
    ? await create(fs, {
        ...options.config,
        resolveFrom: fs.cwd()
      })
    : await resolve(fs, filePath);
  if (!parcelConfig && options.defaultConfig) {
    parcelConfig = await create(fs, {
      ...options.defaultConfig,
      resolveFrom: fs.cwd()
    });
  }

  if (!parcelConfig) {
    throw new Error('Could not find a .parcelrc');
  }

  return parcelConfig;
}

export async function resolve(fs: FileSystem, filePath: FilePath) {
  let configPath = await resolveConfig(fs, filePath, ['.parcelrc']);
  if (!configPath) {
    return null;
  }

  return readAndProcess(fs, configPath);
}

export async function create(fs: FileSystem, config: ParcelConfigFile) {
  return processConfig(fs, config, fs.cwd());
}

export async function readAndProcess(fs: FileSystem, configPath: FilePath) {
  let config: ParcelConfigFile = parse(await fs.readFile(configPath));
  return processConfig(fs, config, configPath);
}

export async function processConfig(
  fs: FileSystem,
  configFile: ParcelConfigFile,
  filePath: FilePath
) {
  let resolvedFile: ResolvedParcelConfigFile = {filePath, ...configFile};
  let config = new ParcelConfig(resolvedFile);
  let relativePath = path.relative(fs.cwd(), filePath);
  validateConfigFile(configFile, relativePath);

  let extendedFiles: Array<FilePath> = [];

  if (configFile.extends) {
    let exts = Array.isArray(configFile.extends)
      ? configFile.extends
      : [configFile.extends];
    for (let ext of exts) {
      let resolved = await resolveExtends(fs, ext, filePath);
      extendedFiles.push(resolved);
      let {
        extendedFiles: moreExtendedFiles,
        config: baseConfig
      } = await readAndProcess(fs, resolved);
      extendedFiles = extendedFiles.concat(moreExtendedFiles);
      config = mergeConfigs(baseConfig, resolvedFile);
    }
  }

  return {config, extendedFiles};
}

export async function resolveExtends(
  fs: FileSystem,
  ext: string,
  configPath: FilePath
) {
  if (ext.startsWith('.')) {
    return path.resolve(path.dirname(configPath), ext);
  } else {
    let [resolved] = await localResolve(ext, configPath);
    return fs.realpath(resolved);
  }
}

export function validateConfigFile(
  config: ParcelConfigFile,
  relativePath: FilePath
) {
  validateExtends(config.extends, relativePath);
  validatePipeline(config.resolvers, 'resolver', 'resolvers', relativePath);
  validateMap(
    config.transforms,
    validatePipeline.bind(this),
    'transformer',
    'transforms',
    relativePath
  );
  validatePackageName(config.bundler, 'bundler', 'bundler', relativePath);
  validatePipeline(config.namers, 'namer', 'namers', relativePath);
  validateMap(
    config.runtimes,
    validatePipeline.bind(this),
    'runtime',
    'runtimes',
    relativePath
  );
  validateMap(
    config.packagers,
    validatePackageName.bind(this),
    'packager',
    'packagers',
    relativePath
  );
  validateMap(
    config.optimizers,
    validatePipeline.bind(this),
    'optimizer',
    'optimizers',
    relativePath
  );
  validatePipeline(config.reporters, 'reporter', 'reporters', relativePath);
}

export function validateExtends(
  exts: string | Array<string> | void,
  relativePath: FilePath
) {
  if (Array.isArray(exts)) {
    for (let ext of exts) {
      assert(
        typeof ext === 'string',
        `"extends" elements must be strings in ${relativePath}`
      );
      validateExtendsConfig(ext, relativePath);
    }
  } else if (exts) {
    assert(
      typeof exts === 'string',
      `"extends" must be a string or array of strings in ${relativePath}`
    );
    validateExtendsConfig(exts, relativePath);
  }
}

export function validateExtendsConfig(ext: string, relativePath: FilePath) {
  if (!ext.startsWith('.')) {
    validatePackageName(ext, 'config', 'extends', relativePath);
  }
}

export function validatePipeline(
  pipeline: ?Pipeline,
  pluginType: string,
  key: string,
  relativePath: FilePath
) {
  if (!pipeline) {
    return;
  }

  assert(
    Array.isArray(pipeline),
    `"${key}" must be an array in ${relativePath}`
  );
  assert(
    pipeline.every(pkg => typeof pkg === 'string'),
    `"${key}" elements must be strings in ${relativePath}`
  );
  for (let pkg of pipeline) {
    if (pkg !== '...') {
      validatePackageName(pkg, pluginType, key, relativePath);
    }
  }
}

export function validateMap<K, V>(
  globMap: ?ConfigMap<K, V>,
  validator: (v: V, p: string, k: string, p: FilePath) => void,
  pluginType: string,
  configKey: string,
  relativePath: FilePath
) {
  if (!globMap) {
    return;
  }

  assert(
    typeof globMap === 'object',
    `"${configKey}" must be an object in ${relativePath}`
  );
  for (let k in globMap) {
    // Flow doesn't correctly infer the type. See https://github.com/facebook/flow/issues/1736.
    let key: K = (k: any);
    validator(globMap[key], pluginType, `${configKey}["${k}"]`, relativePath);
  }
}

export function validatePackageName(
  pkg: ?PackageName,
  pluginType: string,
  key: string,
  relativePath: FilePath
) {
  if (!pkg) {
    return;
  }

  assert(
    typeof pkg === 'string',
    `"${key}" must be a string in ${relativePath}`
  );

  if (pkg.startsWith('@parcel')) {
    assert(
      pkg.replace(/^@parcel\//, '').startsWith(`${pluginType}-`),
      `Official parcel ${pluginType} packages must be named according to "@parcel/${pluginType}-{name}" but got "${pkg}" in ${relativePath}.`
    );
  } else if (pkg.startsWith('@')) {
    let [scope, name] = pkg.split('/');
    assert(
      name.startsWith(`parcel-${pluginType}-`),
      `Scoped parcel ${pluginType} packages must be named according to "${scope}/parcel-${pluginType}-{name}" but got "${pkg}" in ${relativePath}.`
    );
  } else {
    assert(
      pkg.startsWith(`parcel-${pluginType}-`),
      `Parcel ${pluginType} packages must be named according to "parcel-${pluginType}-{name}" but got "${pkg}" in ${relativePath}.`
    );
  }
}

export function mergeConfigs(
  base: ParcelConfig,
  ext: ResolvedParcelConfigFile
): ParcelConfig {
  return new ParcelConfig({
    filePath: ext.filePath, // TODO: revisit this - it should resolve plugins based on the actual config they are defined in
    resolvers: mergePipelines(base.resolvers, ext.resolvers),
    transforms: mergeMaps(base.transforms, ext.transforms, mergePipelines),
    bundler: ext.bundler || base.bundler,
    namers: mergePipelines(base.namers, ext.namers),
    runtimes: mergeMaps(base.runtimes, ext.runtimes),
    packagers: mergeMaps(base.packagers, ext.packagers),
    optimizers: mergeMaps(base.optimizers, ext.optimizers, mergePipelines),
    reporters: mergePipelines(base.reporters, ext.reporters)
  });
}

export function mergePipelines(base: ?Pipeline, ext: ?Pipeline): Pipeline {
  if (!ext) {
    return base || [];
  }

  if (base) {
    // Merge the base pipeline if a rest element is defined
    let spreadIndex = ext.indexOf('...');
    if (spreadIndex >= 0) {
      if (ext.filter(v => v === '...').length > 1) {
        throw new Error(
          'Only one spread element can be included in a config pipeline'
        );
      }

      ext = [
        ...ext.slice(0, spreadIndex),
        ...(base || []),
        ...ext.slice(spreadIndex + 1)
      ];
    }
  }

  return ext;
}

export function mergeMaps<K, V>(
  base: ?ConfigMap<K, V>,
  ext: ?ConfigMap<K, V>,
  merger?: (a: V, b: V) => V
): ConfigMap<K, V> {
  if (!ext) {
    return base || {};
  }

  if (!base) {
    return ext;
  }

  // Add the extension options first so they have higher precedence in the output glob map
  let res: ConfigMap<K, V> = {};
  for (let k in ext) {
    // Flow doesn't correctly infer the type. See https://github.com/facebook/flow/issues/1736.
    let key: K = (k: any);
    res[key] = merger && base[key] ? merger(base[key], ext[key]) : ext[key];
  }

  // Add base options that aren't defined in the extension
  for (let k in base) {
    let key: K = (k: any);
    if (!res[key]) {
      res[key] = base[key];
    }
  }

  return res;
}
