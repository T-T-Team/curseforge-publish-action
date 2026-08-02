const actions = require('@actions/core');
const fs = require('fs');
const path = require('path');

const GAME_VERSION_REGEX = /\+([\w.-]+)$/;
const BASE_API_URL = "https://minecraft.curseforge.com";
const URL_UPLOAD_PROVIDER = (id) => `${BASE_API_URL}/api/projects/${id}/upload-file`;

const EXCLUDED_FILE_SUFFIXES = [
  "sources", "javadoc", "dev", "all", "shadow"
];

const CHANGELOG_TEXT = "text";
const CHANGELOG_HTML = "html";
const CHANGELOG_MARKDOWN = "markdown";
const CHANGELOG_TYPES = [
  CHANGELOG_TEXT, CHANGELOG_HTML, CHANGELOG_MARKDOWN
];

const CHANNEL_RELEASE = "release";
const CHANNEL_BETA = "beta";
const CHANNEL_ALPHA = "alpha";
const RECOGNIZE_CHANNEL_LIST = [
  CHANNEL_ALPHA, CHANNEL_BETA
];
const CHANNEL_TYPES = [
  CHANNEL_RELEASE, ...RECOGNIZE_CHANNEL_LIST
];


const RELATION_REQUIRED = "requiredDependency";
const RELATION_OPTIONAL = "optionalDependency";
const RELATION_EMBEDDED = "embeddedLibrary";
const RELATION_INCOMPATIBLE = "incompatible";
const RELATION_TOOL = "tool";

const ENV_CLIENT = "client";
const ENV_SERVER = "server";
const ENVIRONMENTS = [
  ENV_CLIENT, ENV_SERVER
];
const ENVIRONMENT_NAME_MAPPINGS = {
  [ENV_CLIENT]: "Client",
  [ENV_SERVER]: "Server"
};

const LOADER_FORGE = "forge";
const LOADER_FABRIC = "fabric";
const LOADER_NEOFORGE = "neoforge";
const LOADER_QUILT = "quilt";
const LOADER_RIFT = "rift";
const MOD_LOADERS = [
  LOADER_FORGE, LOADER_FABRIC, LOADER_NEOFORGE, LOADER_QUILT, LOADER_RIFT
];
const LOADER_NAME_MAPPINGS = {
  [LOADER_FORGE]: "Forge",
  [LOADER_FABRIC]: "Fabric",
  [LOADER_NEOFORGE]: "NeoForge",
  [LOADER_QUILT]: "Quilt",
  [LOADER_RIFT]: "Rift"
};

const HTTP_METHOD = {
  GET: "GET",
  POST: "POST"
};

const inputs = {
  artifactDirectory: actions.getInput("artifact-directory", {trimWhitespace: true}),
  token: actions.getInput("token", {trimWhitespace: true}),
  projectId: actions.getInput("project-id", {trimWhitespace: true}),
  changelogContent: actions.getInput("changelog-content", {trimWhitespace: true}),
  changelogType: actions.getInput("changelog-type", {trimWhitespace: true}),
  releaseChannel: actions.getInput("release-channel", {trimWhitespace: true}),
  gameVersion: actions.getInput("game-version", {trimWhitespace: true}),
  modLoader: actions.getInput("mod-loader", {trimWhitespace: true}),
  gameEnvironment: actions.getInput("game-environment", {trimWhitespace: true}),
  javaVersion: actions.getInput("java-version", {trimWhitespace: true}),
  dependencies: {
    required: actions.getInput("required-dependencies", {trimWhitespace: true}),
    optional: actions.getInput("optional-dependencies", {trimWhitespace: true}),
    embedded: actions.getInput("embedded-dependencies", {trimWhitespace: true}),
    incompatible: actions.getInput("incompatible-dependencies", {trimWhitespace: true}),
    tools: actions.getInput("tool-dependencies", {trimWhitespace: true})
  },
  debug: actions.getBooleanInput("debug-mode")
};

async function main() {
  // Assign default values
  setDefaultValuesAndValidate();

  // Prepare all files for upload
  const uploadArtifact = await resolveUploadArtifact();

  // Upload files
  await upload(uploadArtifact);
}

async function upload(artifact) {
  const url = URL_UPLOAD_PROVIDER(inputs.projectId);

  const payload = new FormData();
  payload.append("file", artifact.file, `${artifact.displayName}.jar`);

  const metadata = JSON.stringify({
    displayName: artifact.displayName,
    releaseType: artifact.releaseType,
    changelog: artifact.changelog,
    changelogType: artifact.changelogType,
    gameVersionNames: artifact.gameVersionNames,
    relations: artifact.relations
  });
  payload.append("metadata", metadata);

  const uploadOptions = {
    body: payload
  }
  let versionId = 0;
  if (inputs.debug) {
    actions.info(`Debug mode is enabled, nothing will be uploaded! Payload content:\n${metadata}`);
  } else {
    const result = await sendApiRequest(HTTP_METHOD.POST, url, uploadOptions);
    versionId = result.id;
    actions.info(`File uploaded successfully. created version ID ${versionId}`);
  }
  actions.setOutput("version-id", versionId);
}

function setDefaultValuesAndValidate() {
  requireInput(inputs.artifactDirectory, "artifact-directory");
  requireInput(inputs.token, "token");
  requireInput(inputs.projectId, "project-id");

  // Changelog type
  if (inputs.changelogType && !CHANGELOG_TYPES.includes(inputs.changelogType)) {
    throw new Error(`Unsupported changelog file type '${inputs.changelogType}', must be one of: ${CHANGELOG_TYPES}`);
  }

  // Game environment
  if (inputs.gameEnvironment) {
    const envs = parseInputList(inputs.gameEnvironment);
    for (const env of envs) {
      if (!ENVIRONMENTS.includes(env)) {
        throw new Error(`Invalid game environment '${env}', must be one of: ${ENVIRONMENTS}`);
      }
    }
  }

  // Release channel
  if (inputs.releaseChannel && !CHANNEL_TYPES.includes(inputs.releaseChannel)) {
    throw new Error(`Invalid release channel '${inputs.releaseChannel}', must be one of: ${CHANNEL_TYPES}`);
  }

  // Mod loaders
  if (inputs.modLoader) {
    const loaders = parseInputList(inputs.modLoader);
    for (const loader of loaders) {
      if (!MOD_LOADERS.includes(loader)) {
        throw new Error(`Invalid mod loader '${loader}', must be one of: ${MOD_LOADERS}`);
      }
    }
  }
}

async function resolveUploadArtifact() {
  if (!fs.existsSync(inputs.artifactDirectory)) {
    throw new Error(`Artifact directory does not exist: ${inputs.artifactDirectory}`);
  }

  const allFiles = fs.readdirSync(inputs.artifactDirectory);
  const matchingReleaseFiles = allFiles.filter(filterFile);
  actions.debug(`Loaded ${matchingReleaseFiles.length} matching files`);
  if (actions.isDebug()) {
    matchingReleaseFiles.forEach(file => actions.debug(`File: ${file}`));
  }

  if (matchingReleaseFiles.length !== 1) {
    throw new Error(`Found total ${matchingReleaseFiles.length} artifacts for upload, expected only 1:\n${matchingReleaseFiles}`);
  }

  let resultArtifact = matchingReleaseFiles[0];
  return await processFile(path.join(inputs.artifactDirectory, resultArtifact));
}

function filterFile(file) {
  if (!file.endsWith(".jar")) {
    return false;
  }
  for (const suffix of EXCLUDED_FILE_SUFFIXES) {
    const fullSuffix = `-${suffix}.jar`;
    if (file.endsWith(fullSuffix)) {
      return false;
    }
  }
  return true;
}

async function processFile(artifact) {
  const displayName = path.basename(artifact, ".jar").toLowerCase();
  const releaseChannel = inputs.releaseChannel || resolveReleaseType(displayName);

  // Version names
  const versionNames = [];
  // game version
  resolveGameVersion(displayName, versionNames);
  // mod loader
  resolveModLoaders(displayName, versionNames);
  // environment
  addGameVersion(inputs.gameEnvironment, versionNames, ENVIRONMENT_NAME_MAPPINGS);
  // java version - optional
  if (inputs.javaVersion) {
    addGameVersion(inputs.javaVersion, versionNames);
  }

  // Dependencies
  const dependencies = [];
  resolveDependencyList(inputs.dependencies.required, RELATION_REQUIRED, dependencies);
  resolveDependencyList(inputs.dependencies.optional, RELATION_OPTIONAL, dependencies);
  resolveDependencyList(inputs.dependencies.embedded, RELATION_EMBEDDED, dependencies);
  resolveDependencyList(inputs.dependencies.incompatible, RELATION_INCOMPATIBLE, dependencies);
  resolveDependencyList(inputs.dependencies.tools, RELATION_TOOL, dependencies);

  // Read the file
  const fileContent = await fs.promises.readFile(artifact);
  const blob = new Blob([fileContent], {type: "application/java-archive"});

  return {
    file: blob,
    displayName: displayName,
    releaseType: releaseChannel,
    changelog: inputs.changelogContent,
    changelogType: inputs.changelogType,
    relations: {
      projects: dependencies
    },
    gameVersionNames: versionNames
  }
}

function addGameVersion(input, output, mappings = {}) {
  let values = parseInputList(input);
  if (mappings) {
    values = values.map(value => mappings[value] || value);
  }
  output.push(...values)
}

function resolveGameVersion(name, output) {
  const gameVersions = [];

  if (inputs.gameVersion) {
    addGameVersion(inputs.gameVersion, gameVersions);
  } else {
    const match = name.match(GAME_VERSION_REGEX);
    if (match) {
      gameVersions.push(match[1]);
    }
  }

  if (gameVersions.length === 0) {
    throw new Error(`Unable to resolve game version from filename '${name}', please include 'game-version' action input`);
  }

  output.push(...gameVersions);
}

function resolveModLoaders(name, output) {
  const loaders = [];

  if (inputs.modLoader) {
    addGameVersion(inputs.modLoader, loaders, LOADER_NAME_MAPPINGS);
  } else {
    for (const loader of MOD_LOADERS) {
      if (name.includes(`-${loader}`)) {
        loaders.push(loader);
      }
    }
  }

  if (loaders.length === 0) {
    throw new Error(`Unable to resolve mod loaders from filename '${name}', please include 'mod-loader' action input`);
  }

  output.push(...loaders);
}

function resolveReleaseType(filename) {
  for (const channel of RECOGNIZE_CHANNEL_LIST) {
    if (filename.includes(`-${channel}`)) {
      return channel;
    }
  }
  return CHANNEL_RELEASE;
}

function resolveDependencyList(inputString, relation, output) {
  if (!inputString)
    return;
  const slugs = parseInputList(inputString);
  output.push(...slugs.map(slug => {
    return {
      slug: slug,
      type: relation
    }
  }));
}

function parseInputList(values, separator = ",") {
  if (!values) {
    return [];
  }
  const result = values.split(separator);
  return result.map(value => value.trim()).filter(Boolean);
}

function requireInput(value, name) {
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }
}

async function sendApiRequest(method, url, options = {}, contentLogging = true) {
  const headers = options?.headers || {};
  const requestOptions = {
    ...options,
    method,
    headers: {
      ...headers,
      "X-Api-Token": inputs.token
    }
  };
  if (contentLogging) {
    const body = options?.body || {};
    actions.debug(`Sending request to ${url} with body:\n${JSON.stringify(body, null, 2)}`);
  }
  const response = await fetch(url, requestOptions);
  const body = await response.text();
  if (actions.isDebug() && contentLogging) {
    actions.debug("Response content:");
    actions.debug(body);
  }
  if (!response.ok) {
    throw new Error(`CurseForge API request failed: ${response.status} ${response.statusText}\n${body}`);
  }
  return JSON.parse(body);
}

main()
  .catch(e => actions.setFailed(e.message));