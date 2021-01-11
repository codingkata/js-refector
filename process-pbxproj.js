// This file is intended to be called by main.go. The reason for having a
// separate file processing the pbxproj files is due to the fact that handling a
// json file with mixed types is hard in a strongly typed language.

const assert = require("assert");
const child_process = require("child_process");
const os = require("os");
const path = require("path");
const util = require("util");

const minimist = require("minimist");

const plutilBin = "/usr/bin/plutil";
const xcodebuildBin = "/usr/bin/xcodebuild";

// TODO(xshi): Refactor and rewrite this file in typescript.
async function main() {
  const flags = minimist(process.argv.slice(2));
  console.error([flags.project_target].flat());
  const g = new BuildGraph(flags.source_root, [flags.project_target].flat());
  const bse = new BuildSettingsExtractor(flags.source_root);
  await g.resolveConfigs(bse);
  console.log(JSON.stringify(
    downlevelESContainer(g),
    (key, value) => /^_/.test(key) ? undefined : value,
    flags.human_readable === "false" ? 0 : 2,
  ));
  console.warn("Done processing all pbxproj files!");
}

class BuildGraph {
  constructor(srcRoot, entryProjectTargets) {
    this.sourceRoot = path.resolve(srcRoot) + "/";
    this.entryTargetUUIDs = [];
    this.targets = new Map();
    this._configCache = new Map();
    this._loadTargets(entryProjectTargets);
  }
  _loadTargets(entryProjectTargets) {
    const projects = new Map();
    const q = [];
    const loadProj = (projCfgDir) => {
      if (projects.has(projCfgDir)) {
        return projects.get(projCfgDir);
      }
      const p = loadPBXProject(this.sourceRoot, projCfgDir);
      projects.set(projCfgDir, p);
      return p;
    };
    const loadTarget = (ut) => {
      const p = loadProj(ut.projectConfigDir);
      if (!p.targets.has(ut.targetUUID)) {
        throw new Error(`No target with uuid ${ut.targetUUID} in ${ut.projectConfigDir}`);
      }
      return p.targets.get(ut.targetUUID);
    };
    const addEntryTarget = (t) => {
      this.entryTargetUUIDs.push(t.uuid);
      q.push(new UnresolvedTarget(t.projectConfigDir, t.uuid));
    };
    const loadEntryProjectTarget = (pt) => {
      const [projCfgDir, targetName] = pt.split(":");
      const entryProj = loadProj(projCfgDir);
      if (targetName === "*") {
        for (const t of entryProj.targets.values()) {
          addEntryTarget(t);
        }
        return;
      }
      const entryTarget = Array.from(entryProj.targets.values()).find((t) => t.name === targetName);
      if (!entryTarget) {
        throw new Error(`No target with name ${targetName} in ${projCfgDir}`);
      }
      addEntryTarget(entryTarget);
    };
    for (const pt of entryProjectTargets) {
      loadEntryProjectTarget(pt);
    }
    while (q.length) {
      const ut = q.shift();
      try {
        const t = loadTarget(ut);
        ut.targetUUID = t.uuid;
        this.targets.set(t.uuid, t);
        for (const dep of t.runtimeDeps) {
          if (this.targets.has(dep.targetUUID)) {
            continue;
          }
          q.push(dep);
        }
        for (const dep of t.deps) {
          if (this.targets.has(dep.targetUUID)) {
            continue;
          }
          q.push(dep);
        }
      } catch (e) {
        console.error(ut, e);
      }
    }
  }
  resolveConfigs(bse) {
    return Promise.all(Array.from(this.targets.values(), t => t.resolveConfigs(bse)));
  }
}

const dstSubfolderSpecs = new Map([
  ["0", "absolute_path"],
  ["1", "wrapper"],
  ["6", "executables"],
  ["7", "resources"], // default
  ["10", "frameworks"],
  ["11", "shared_frameworks"],
  ["12", "shared_support"],
  ["13", "plug_ins"],
  ["15", "java_resources"],
  ["16", "products_directory"],
]);

class Target {
  constructor(srcRoot, projCfgDir, projRoot, pt) {
    this.sourceRoot = srcRoot;
    this.projectConfigDir = projCfgDir;
    this.projectRoot = projRoot;
    this.uuid = pt.uuid;
    this.name = pt.name;
    this.productName = pt.productName;
    this.product = pt.productReference?.path;
    this.configs = {};
    this._configNames = pt.buildConfigurationList.buildConfigurations.map(cfg => cfg.name);
    this.resources = new Map();
    this.sources = new Map();
    this.copiedSources = new Map();
    this.sdkDylibs = new Set();
    this.sdkFrameworks = new Set();
    this.weakSDKFrameworks = new Set();
    this.runtimeDeps = [];
    this.deps = [];
    for (const pbp of pt.buildPhases) {
      switch (pbp.isa) {
        case "PBXResourcesBuildPhase": {
          this._addResourceBuildPhase(pbp);
          break;
        }
        case "PBXSourcesBuildPhase": {
          this._addSourceBuildPhase(pbp);
          break;
        }
        case "PBXFrameworksBuildPhase": {
          this._addFrameworksBuildPhase(pbp);
          break;
        }
        case "PBXCopyFilesBuildPhase": {
          this._addCopyFileBuildPhase(pbp);
          break;
        }
        case "PBXShellScriptBuildPhase": {
          // TODO(xshi): check if we need to support those suckers.
          break;
        }
        default: {
          console.warn("unknown build phase type %j", pbp.isa);
          break;
        }
      }
    }
    // console.warn("TARGET", pt);
    for (const pd of pt.dependencies) {
      // console.warn("DEP", pd)
      if (pd.platformFilter === "maccatalyst") {
        continue;
      }
      this.deps.push(new UnresolvedTarget(
        pd.targetProxy.containerPortal.path || this.projectConfigDir,
        pd.targetProxy.remoteGlobalIDString,
      ));
    }
  }
  _addResourceBuildPhase(pbp) {
    for (const f of pbp.files) {
      if (!f?.fileRef) {
        // console.error("no fileRef: %o", f)
        continue;
      }
      switch (f.fileRef.isa) {
        case "PBXFileReference": {
          this.resources.set(f.fileRef.path, f.fileRef.virtualPath);
          break;
        }
        default: {
          console.warn("Unsupported resource: %o", f.fileRef);
        }
      }
    }
  }
  _addCopyFileBuildPhase(pbp) {
    const vars = this._getVars();
    const dst = expandVars(pbp.dstPath, vars);
    switch (pbp.dstSubfolderSpec) {
      case "16": {
        for (const f of pbp.files) {
          const fr = f.fileRef;
          this.copiedSources.set(path.join(dst, path.basename(fr.path)), fr.path);
        }
        break;
      }
      default: {
        console.warn("unsupported copy dst: ", dstSubfolderSpecs.get(pbp.dstSubfolderSpec), dst);
      }
    }
  }
  _addSourceBuildPhase(pbp) {
    for (const f of pbp.files) {
      if (!f?.fileRef) {
        // console.error("no fileRef: %o", f)
        continue;
      }
      this.sources.set(f.fileRef.path, f.settings?.COMPILER_FLAGS || "");
    }
  }
  _addFrameworksBuildPhase(pbp) {
    for (const f of pbp.files) {
      const fr = f.fileRef;
      if (!fr) {
        console.error("no fileRef: %o", f);
        continue;
      }
      switch (fr.isa) {
        case "PBXFileReference": {
          const framework = /System\/Library\/Frameworks\/(.+)\.framework/.exec(fr.path);
          if (framework) {
            if (f?.settings?.settings?.ATTRIBUTES?.includes("Weak")) {
              this.weakSDKFrameworks.add(framework[1]);
            } else {
              this.sdkFrameworks.add(framework[1]);
            }
            continue;
          }
          const dylib = /usr\/lib\/(.*)\.(dylib|tbd)/.exec(fr.path);
          if (dylib) {
            this.sdkDylibs.add(dylib[1]);
            continue;
          }
          console.warn("!!!Framework-DEP", fr);
          break;
        }
        case "PBXReferenceProxy": {
          // console.warn("!!!REF", fr);
          this.runtimeDeps.push(new UnresolvedTarget(
            fr.remoteRef.path || fr.remoteRef.containerPortal.path || this.projCfgDir,
            fr.remoteRef.remoteGlobalIDString,
          ));
          break;
        }
        default: {
          console.warn("Unsupported framework: %o", fr);
          break;
        }
      }
    }
  }
  _getVars() {
    return new Map([
      // ["ARCHS_STANDARD", ""],
      // ["ARCHS_STANDARD_32_BIT", ""],
      // ["ARCHS_STANDARD_INCLUDING_64_BIT", ""],
      // ["BUILD_DIR", ""],
      // ["BUILT_PRODUCTS_DIR", ""],
      // ["BUNDLE_LOADER", ""],
      // ["CLANG_WARN_SUSPICIOUS_IMPLICIT_CONVERSION", ""],
      // ["CONFIGURATION", ""],
      // ["CURRENT_ARCH", ""],
      // ["CURRENT_VARIANT", ""],
      // ["DEVELOPER_FRAMEWORKS_DIR", ""],
      // ["EFFECTIVE_PLATFORM_NAME", ""],
      // ["LOCAL_LIBRARY_DIR", ""],
      // ["OTHER_CFLAGS", ""],
      // ["PLATFORM_NAME", ""],
      // ["PODS_CONFIGURATION_BUILD_DIR", ""],
      ["PODS_ROOT", this.sourceRoot],
      ["PRODUCT_NAME", this.productName],
      // ["PROJECT_DIR", ""],
      // ["PROJECT_NAME", ""],
      // ["PROJECT_TEMP_DIR", ""],
      // ["SDKROOT", ""],
      ["SRCROOT", this.projectRoot],
      // ["TARGET_NAME", ""],
      // ["TARGET_TEMP_DIR", ""],
      // ["TEST_HOST", ""],
      // ["USER_LIBRARY_DIR", ""],
    ]);
  }
  async resolveConfigs(bse) {
    const cfgProms = this._configNames.map(cfg => bse.query(this.projectConfigDir, this.name, cfg));
    this.configs = this._resolveConfigs(await Promise.all(cfgProms));
  }
  _resolveConfigs(cfgs) {
    if (cfgs.length === 0) {
      return {
        release: undefined,
        overrides: [],
      };
    }
    cfgs = deepClone(cfgs);
    for (const cfg of cfgs) {
      if (cfg.buildSettings.GCC_PREFIX_HEADER) {
        cfg.buildSettings.GCC_PREFIX_HEADER = path.resolve(this.projectRoot, cfg.buildSettings.GCC_PREFIX_HEADER);
      }
    }
    const release = deepClone(cfgs.find((cfg) => /release/i.test(cfg.name)));
    if (!release) {
      return {
        release: undefined,
        overrides: cfgs,
      };
    }
    cfgs.forEach((c) => keepEqualParts(release, c));
    const overrides = deepClone(cfgs).map((c) => {
      deepExclude(c, release);
      return c;
    });
    return {
      release,
      overrides,
    };
  }
}

class Throttler {
  constructor(n) {
    this._queue = [];
    this._tokens = [];
    const returnToken = (tk) => {
      const resolve = this._queue.shift();
      if (resolve) {
        resolve(tk);
        return;
      }
      this._tokens.push(tk);
    };
    for (let i = 0; i < n; i++) {
      this._tokens.push({
        return() {
          returnToken(this);
        }
      });
    }
  }
  get token() {
    if (this._tokens.length) {
      const tk = this._tokens.pop();
      return Promise.resolve(tk);
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }
}

const execFile = util.promisify(child_process.execFile);
// xcodebuild is slow, we must run them in parallel with throttler.
const xcodebuildThrottler = new Throttler(os.cpus().length);
const stringListBuildSettingNames = new Set([
  "GCC_PREPROCESSOR_DEFINITIONS",
  "HEADER_SEARCH_PATHS",
  "OTHER_LDFLAGS",
]);

class BuildSettingsExtractor {
  constructor(srcRoot) {
    this._sourceRoot = srcRoot;
    this._cache = new Map();
  }
  async query(project, target, config) {
    const ss = await this._queryAll(project, config);
    return {
      name: config,
      buildSettings: ss.get(target) || {},
    };
  }
  _queryAll(project, config) {
    const key = [project, config].join("@");
    if (this._cache.has(key)) {
      return this._cache.get(key);
    }
    const settings = new Promise(async (resolve) => {
      const tk = await xcodebuildThrottler.token;
      const { stdout } = await execFile(xcodebuildBin, [
        "-showBuildSettings", "-json",
        "-project", path.join(this._sourceRoot, project),
        "-alltargets",
        "-configuration", config,
      ], {
        maxBuffer: 10 << 20,
      });
      const data = JSON.parse(stdout.toString());
      resolve(new Map(data.map((t) => [t.target, this._processBuildSettings(t.buildSettings)])));
      tk.return();
    });
    this._cache.set(key, settings);
    return settings;
  }
  _processBuildSettings(bs) {
    const res = {};
    for (const name in bs) {
      const t = bs[name].trim();
      if (!t) {
        continue;
      }
      if (stringListBuildSettingNames.has(name)) {
        res[name] = this._parseStringListBuildSetting(t);
      } else {
        res[name] = t;
      }
    }
    return res;
  }
  _parseStringListBuildSetting(l) {
    return l.split(/(?<!\\) /g)
      .map((v) => v.replace(/\\(.)/g, (_, escaped) => escaped).replace(/"/g, ""));
  }
}

function expandVars(s, vars) {
  return s.replace(/\$[{(]?(\w+)[})]?/g, (full, name) => {
    if (vars.has(name)) {
      return vars.get(name);
    }
    // This is way too noisy to read.
    // console.warn("Failed to resolve variable in %s: %s", s, name)
    return full;
  });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function keepEqualParts(base, obj) {
  for (const key in base) {
    if (!(key in obj) || typeof base[key] !== typeof obj[key]) {
      delete base[key];
      continue;
    }
    if (isDeepEqual(base[key], obj[key])) {
      continue;
    }
    if (Array.isArray(base[key])) {
      delete base[key];
      continue;
    }
    if (typeof base[key] === "object") {
      keepEqualParts(base[key], obj[key]);
    } else {
      delete base[key];
    }
  }
}

function deepExclude(obj, ex) {
  for (const key in obj) {
    if (!(key in ex)) {
      continue;
    }
    if (!Array.isArray(obj[key]) && typeof obj[key] === "object") {
      deepExclude(obj[key], ex[key]);
      continue;
    }
    delete obj[key];
  }
  return obj;
}

function isDeepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch (e) {
    return false;
  }
}

function downlevelESContainer(o) {
  if (o instanceof Map) {
    const t = {};
    for (const [key, v] of o) {
      t[key] = downlevelESContainer(v);
    }
    return t;
  }
  if (o instanceof Set) {
    return Array.from(o, downlevelESContainer).sort();
  }
  if (Array.isArray(o)) {
    return o.map(downlevelESContainer);
  }
  if (typeof o === "object") {
    const t = {};
    for (const [key, v] of Object.entries(o)) {
      t[key] = downlevelESContainer(v);
    }
    return t;
  }
  return o;
}

class UnresolvedTarget {
  constructor(projCfgDir, targetUUID) {
    this.projectConfigDir = projCfgDir;
    this.targetUUID = targetUUID;
  }
}

function loadPBXProject(srcRoot, projCfgDir) {
  const projCfgFile = path.join(srcRoot, projCfgDir, "project.pbxproj");
  const json = child_process.execFileSync(plutilBin, [
    "-convert", "json",
    "-o", "-",
    projCfgFile
  ], {
    maxBuffer: 10 << 20,
  }).toString();
  const data = JSON.parse(json);
  deref(data, data.objects);
  // Add uuid for all objects.
  for (const uuid in data.objects) {
    data.objects[uuid].uuid = uuid;
  }
  const p = data.rootObject;
  const projRoot = path.dirname(path.join(srcRoot, projCfgDir));
  if (p.mainGroup) {
    resolveGroupFiles(p.mainGroup, srcRoot, projRoot);
  }
  if (p.productRefGroup) {
    console.warn("productRefGroup", p.productRefGroup);
  }
  const targets = new Map();
  p.targets.forEach((pt) => {
    const t = new Target(srcRoot, projCfgDir, projRoot, pt);
    targets.set(pt.uuid, t);
    if (pt.productReference) {
      targets.set(pt.productReference.uuid, t);
    }
  });
  p.targets = targets;
  return p;
}

const uuidPattern = /^[0-9A-F]{24,32}$/;

function deref(v, objs) {
  switch (typeof v) {
    case "string":
      if (uuidPattern.test(v)) {
        if (v in objs) {
          return objs[v];
        }
        return v;
      }
      return v;
    case "object":
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          v[i] = deref(v[i], objs);
        }
      } else {
        for (const [field, value] of Object.entries(v)) {
          if (field === "remoteGlobalIDString") {
            continue;
          }
          v[field] = deref(value, objs);
        }
      }
  }
  return v;
}

function resolveGroupFiles(obj, sourceRoot, projRoot, groupRoot = projRoot, virtualRoot = projRoot) {
  if (!obj) {
    return;
  }
  switch (obj.isa) {
    case "PBXFileReference": {
      if (obj.name && obj.path && obj.name !== path.basename(obj.path)) {
        console.warn("Referenced File got renamed: %j != %j", obj.name, obj.path);
      }
      // https://www.rubydoc.info/gems/xcodeproj/Xcodeproj/Project/Object/PBXFileReference
      switch (obj.sourceTree) {
        case "SOURCE_ROOT": {
          obj.sourceTree = "<absolute>";
          obj.path = path.relative(sourceRoot, path.resolve(projRoot, obj.path));
          break;
        }
        case "<group>": {
          obj.sourceTree = "<absolute>";
          obj.path = path.relative(sourceRoot, path.resolve(groupRoot, obj.path));
          break;
        }
        case "<absolute>":
        case "BUILT_PRODUCTS_DIR":
        case "SDKROOT":
        case "DEVELOPER_DIR": {
          break;
        }
        default: {
          console.warn("Unknown sourceTree type: %j", obj);
        }
      }
      obj.virtualPath = path.join(virtualRoot, obj.name || path.basename(obj.path));
      break;
    }
    case "PBXGroup": {
      if (obj.path) {
        switch (obj.sourceTree) {
          case "SOURCE_ROOT": {
            groupRoot = path.resolve(projRoot, obj.path);
            break;
          }
          case "<group>": {
            groupRoot = path.resolve(groupRoot, obj.path);
            break;
          }
        }
      }
      virtualRoot = path.resolve(virtualRoot, obj.name || path.basename(obj.path || ""));
      obj.children.forEach(f => resolveGroupFiles(f, sourceRoot, projRoot, groupRoot, virtualRoot));
      break;
    }
    default: {
      console.warn("Invalid type: %j", obj.isa);
      break;
    }
  }
}

if (require.main === module) {
  main();
}
