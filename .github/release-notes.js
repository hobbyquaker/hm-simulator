#!/usr/bin/env node

/* Usage: node .github/release-notes.js v1.0.0 > notes.md
   Prints the README's changelog section for the given tag plus the commits
   since the previous tag. Used by the github-release job in release.yml. */

'use strict';

const {execSync} = require('node:child_process');
const fs = require('node:fs');

const tag = process.argv[2];
if (!tag) {
    console.error('usage: release-notes.js <tag>');
    process.exit(1);
}

const version = tag.replace(/^v/, '');

// the changelog lives in the README, as "### <version>" under "## Changelog"
const lines = fs.readFileSync('README.md', 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith('### ') && line.includes(version));
let section = '';
if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
    section = lines
        .slice(start + 1, end === -1 ? lines.length : end)
        .join('\n')
        .trim();
}

let commits = '';
try {
    const previous = execSync(`git describe --tags --abbrev=0 ${tag}^`, {encoding: 'utf8'}).trim();
    commits = execSync(`git log --pretty=format:"- %s (%h)" ${previous}..${tag}`, {encoding: 'utf8'}).trim();
    if (commits) {
        commits = `\n\n### Commits since ${previous}\n\n${commits}`;
    }
} catch {
    // first release: no previous tag
}

process.stdout.write((section || `Release ${version}`) + commits + '\n');
