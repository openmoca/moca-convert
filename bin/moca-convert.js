#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { formatText, formatJson } from '@openmoca/moca-core';
import { resolveInputTarget, UsageError } from '../lib/target.js';
import { resolveAdapterName } from '../lib/detect.js';
import { getAdapter } from '../lib/adapters/index.js';
import { writeDraft, ConversionFailedError } from '../lib/write.js';

const ADAPTER_ONLY_FLAGS = {
  exclude: 'obsidian',
  minDescriptionRatio: 'openapi',
  chunker: 'openapi',
  sources: 'pdf',
};

function parseRatio(value) {
  const num = Number(value);
  if (Number.isNaN(num) || num < 0 || num > 1) {
    throw new InvalidArgumentError('must be a number between 0 and 1.');
  }
  return num;
}

// npm always includes package.json in a published tarball, regardless of the
// "files" field, so reading the version from it works once installed.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

const program = new Command();
program
  .name('moca-convert')
  .description('Create a MOCA package, with an OKF content bundle, from a directory, Markdown files, an Obsidian vault, a suitable OpenAPI document, PDFs, or a YouTube capture folder.')
  // `--version <semver>` already sets the *generated package's* version, so the
  // CLI's own version is exposed as --cli-version rather than redefining it.
  .version(version, '-V, --cli-version', "output moca-convert's own version")
  .argument('<input>', 'source file or directory to convert')
  .requiredOption('-o, --output <dir>', 'output package directory')
  .requiredOption('--id <uri>', 'package id: an absolute URI, e.g. https://example.com/kb/support')
  .option('--title <string>', 'manifest title for the converted package')
  .option('--version <semver>', 'manifest version for the converted package', '1.0.0')
  .option('--type <type>', 'OKF type for nodes that lack one (default per adapter: Document, Note, API Operation)')
  .option('--language <bcp47>', 'default content language, e.g. en')
  .option('--license <spdx>', 'SPDX license expression for the package')
  .option('--from <format>', 'source format: directory|markdown|obsidian|openapi|pdf|youtube (auto-detected if omitted)')
  .option('--exclude <glob...>', 'obsidian only: note paths to exclude from conversion (still indexed for wikilink resolution)')
  .option('--min-description-ratio <ratio>', 'openapi only: minimum fraction of operations needing a summary/description, 0-1 (default 0.5)', parseRatio)
  .option('--chunker <mode>', 'openapi only: operation|tag content-node grouping (default operation)')
  .option('--sources <mode>', 'pdf only: copy the PDFs into sources/ (copy, the default) or cite each by its pdfs.json url (link)')
  .option('--no-structure', 'directory only: do not write structure.ttl from the folders, or bind nodes to it')
  .option('--force', 'allow writing into a non-empty output directory', false)
  .option('--strict', 'escalate warning-level output-validation findings to errors', false)
  .option('--format <fmt>', 'summary output format: text|json', 'text')
  .option('--report <file>', 'write the formatted summary to a file (in addition to console output)')
  .option('--log-file <file>', 'write a full debug trace (pass timings) regardless of verbosity')
  .option('-v, --verbose', 'increase console verbosity (repeatable)', (_, prev) => prev + 1, 0)
  .option('-q, --quiet', 'suppress non-error console output', false)
  .option('--no-color', 'disable colored output')
  .action(async (input, options) => {
    await run(input, options);
  });

// Commander's own usage errors (missing required options, unknown flags,
// --help) default to exit code 1; override so they participate in the same
// 0/2 usage-error convention as everything this CLI throws itself.
program.exitOverride();

program.parseAsync(process.argv).catch((err) => {
  if (err.code && err.code.startsWith('commander.')) {
    process.exit(err.code === 'commander.helpDisplayed' ? 0 : 2);
  }
  throw err;
});

function makeLogger(options) {
  const lines = [];
  return {
    log: (line) => {
      lines.push(line);
      if (options.verbose > 0) console.error(`[trace] ${line}`);
    },
    flush: () => {
      if (options.logFile) {
        appendFileSync(options.logFile, lines.join('\n') + '\n');
      }
    },
  };
}

function writeReport(options, formatted) {
  if (options.report) {
    writeFileSync(options.report, formatted);
  }
  if (!options.quiet && (!options.report || options.format === 'text')) {
    console.log(formatted);
  }
}

async function run(input, options) {
  const logger = makeLogger(options);
  try {
    const target = resolveInputTarget(input);
    const adapterName = resolveAdapterName(target, options.from);
    assertAdapterSpecificFlags(adapterName, options);
    const adapter = getAdapter(adapterName);

    const draft = await adapter.convert({
      inputPath: input,
      options: {
        id: options.id,
        title: options.title,
        version: options.version,
        exclude: options.exclude,
        minDescriptionRatio: options.minDescriptionRatio,
        chunker: options.chunker,
        sources: options.sources,
        structure: options.structure,
        type: options.type,
        language: options.language,
        license: options.license,
      },
    });

    const { findings, digest } = await writeDraft({
      draft,
      outDir: options.output,
      force: options.force,
      strict: options.strict,
      onLog: logger.log,
    });

    if (!options.quiet) {
      console.log(`Wrote ${options.output} (${draft.contentNodes.length} content node(s), ${draft.warnings.length} warning(s))\n${digest}`);
    }
    for (const warning of draft.warnings) {
      console.error(`moca-convert: WARNING ${warning.code}  ${warning.file ? `${warning.file}: ` : ''}${warning.message}`);
    }
    if (findings.length > 0) {
      writeReport(options, formatFindings(findings, options.format));
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`moca-convert: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof ConversionFailedError) {
      console.error(`moca-convert: ${err.message}`);
      writeReport(options, formatFindings(err.findings, options.format));
      process.exit(1);
    }
    throw err;
  } finally {
    logger.flush();
  }
}

function assertAdapterSpecificFlags(adapterName, options) {
  for (const [flag, owner] of Object.entries(ADAPTER_ONLY_FLAGS)) {
    if (options[flag] !== undefined && adapterName !== owner) {
      throw new UsageError(`--${flag} is only valid with the ${owner} adapter (resolved adapter: ${adapterName}).`);
    }
  }
}

function formatFindings(findings, format) {
  if (format === 'json') return formatJson(findings);
  return formatText(findings);
}
