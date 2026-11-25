import { describe, expect, it } from 'vitest';
import { editDistance, findTypoTarget, maxDistanceFor, suggest } from '../src/typo.js';
import { npm } from '../src/ecosystems/npm.js';
import { pypi } from '../src/ecosystems/pypi.js';

const TOP = ['react', 'express', 'lodash', 'cross-env', '@types/node', 'requests', 'colorama', 'ms', 'python-dateutil'];

describe('editDistance', () => {
  it.each([
    ['kitten', 'sitting', 3],
    ['lodash', 'lodash', 0],
    ['lodash', 'lodahs', 1], // adjacent transposition counts once
    ['express', 'expres', 1],
    ['react', 'raect', 1],
    ['', 'abc', 3],
  ])('%s -> %s = %i', (a, b, d) => {
    expect(editDistance(a, b)).toBe(d);
  });

  it('exits early past max', () => {
    expect(editDistance('abcdefgh', 'zzzzzzzz', 2)).toBe(3);
  });
});

describe('maxDistanceFor', () => {
  it('scales with length', () => {
    expect(maxDistanceFor('ms')).toBe(0);
    expect(maxDistanceFor('react')).toBe(1);
    expect(maxDistanceFor('typescript')).toBe(2);
  });
});

describe('findTypoTarget', () => {
  it.each([
    ['lodahs', 'lodash', 'edit'],
    ['expresss', 'express', 'edit'],
    ['crossenv', 'cross-env', 'separator'],
    ['cross_env', 'cross-env', 'separator'],
    ['typesnode', '@types/node', 'scope'],
    ['co1orama', 'colorama', 'homoglyph'],
    ['reqeusts', 'requests', 'edit'],
  ])('%s looks like %s (%s)', (name, target, kind) => {
    const hit = findTypoTarget(name, TOP);
    expect(hit?.target).toBe(target);
    expect(hit?.kind).toBe(kind);
  });

  it('returns nothing for the package itself', () => {
    expect(findTypoTarget('react', TOP)).toBeUndefined();
  });

  it('ignores very short names', () => {
    expect(findTypoTarget('mz', TOP)).toBeUndefined();
  });

  it('ignores names that are far away', () => {
    expect(findTypoTarget('fastify', TOP)).toBeUndefined();
    expect(findTypoTarget('left-pad', TOP)).toBeUndefined();
  });

  it('prefers the closest and most popular target', () => {
    expect(findTypoTarget('reactt', ['react', 'reacts'])?.target).toBe('react');
  });

  it('works against the bundled top lists', () => {
    expect(findTypoTarget('expres', npm.topPackages())?.target).toBe('express');
    expect(findTypoTarget('reqeusts', pypi.topPackages())?.target).toBe('requests');
    expect(findTypoTarget('express', npm.topPackages())).toBeUndefined();
  });
});

describe('suggest', () => {
  it('uses a looser threshold for did-you-mean', () => {
    expect(suggest('requestss', TOP)).toBe('requests');
    expect(suggest('totally-unrelated-name', TOP)).toBeUndefined();
  });
});
