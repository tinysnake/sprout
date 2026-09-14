import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Project } from './model.ts';
import { assembleProjectContract, membershipFor, renderProjectContract } from './contract.ts';

/**
 * Project contract assembly (O5, #21).
 *
 * The contract is the assembled text every engine is handed as standing
 * instructions. These pin that it contains the project's goal, rules,
 * membership responsibilities, available environments, and the agent's own
 * configuration, and that assembly is deterministic.
 */

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship a portable project context',
    rules: ['Report what you observed', 'Do not claim unverified work'],
    availableEnvironmentInstanceIds: ['mac-mini-1', 'container-1'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Investigate the repository', 'Answer direct requests'],
        collaborationInstructions: 'Keep results concise',
      },
      {
        agentId: 'agent-builder',
        responsibilities: ['Implement changes'],
        collaborationInstructions: 'Follow the settled language',
      },
    ],
    ...overrides,
  };
}

test('the contract contains the goal, rules, membership responsibilities, and environments', () => {
  const contract = assembleProjectContract({
    project: project(),
    agentId: 'agent-scout',
    agentInstructions: 'You are Scout.',
  });

  assert.equal(contract.projectId, 'project-sprout');
  assert.equal(contract.goal, 'Ship a portable project context');
  assert.deepEqual(contract.rules, ['Report what you observed', 'Do not claim unverified work']);
  assert.deepEqual(contract.responsibilities, ['Investigate the repository', 'Answer direct requests']);
  assert.equal(contract.collaborationInstructions, 'Keep results concise');
  assert.deepEqual(contract.availableEnvironmentInstanceIds, ['mac-mini-1', 'container-1']);
  assert.equal(contract.agentInstructions, 'You are Scout.');
});

test('the contract takes the responsibilities of the agent it is assembled for, not another member', () => {
  const forScout = assembleProjectContract({ project: project(), agentId: 'agent-scout' });
  const forBuilder = assembleProjectContract({ project: project(), agentId: 'agent-builder' });

  assert.deepEqual(forScout.responsibilities, [
    'Investigate the repository',
    'Answer direct requests',
  ]);
  assert.deepEqual(forBuilder.responsibilities, ['Implement changes']);
  assert.equal(forBuilder.collaborationInstructions, 'Follow the settled language');
  assert.notDeepEqual(forScout.responsibilities, forBuilder.responsibilities);
});

test('an agent with no membership gets an empty responsibility set, not a crash', () => {
  const contract = assembleProjectContract({ project: project(), agentId: 'agent-unknown' });
  assert.deepEqual(contract.responsibilities, []);
  assert.equal(contract.collaborationInstructions, '');
  assert.equal(membershipFor(project(), 'agent-unknown'), undefined);
});

test('rendering is deterministic: the same contract always produces byte-identical text', () => {
  const request = {
    project: project(),
    agentId: 'agent-scout',
    agentInstructions: 'You are Scout.',
  } as const;
  const first = renderProjectContract(assembleProjectContract(request));
  const second = renderProjectContract(assembleProjectContract(request));
  assert.equal(first, second);

  // Every required part is present and human-readable.
  assert.match(first, /# Project contract: project-sprout/);
  assert.match(first, /Goal: Ship a portable project context/);
  assert.match(first, /Rules:\n- Report what you observed/);
  assert.match(first, /Your responsibilities:\n- Investigate the repository/);
  assert.match(first, /Collaboration: Keep results concise/);
  assert.match(first, /Available environments:\n- mac-mini-1\n- container-1/);
  assert.match(first, /Your standing instructions:\nYou are Scout\./);
});

test('empty sections are omitted rather than rendered as dangling headings', () => {
  const rendered = renderProjectContract(
    assembleProjectContract({
      project: project({
        rules: [],
        memberships: [],
        availableEnvironmentInstanceIds: [],
      }),
      agentId: 'agent-scout',
    }),
  );

  assert.equal(rendered, '# Project contract: project-sprout\n\nGoal: Ship a portable project context');
  assert.doesNotMatch(rendered, /Rules:/);
  assert.doesNotMatch(rendered, /Your responsibilities:/);
  assert.doesNotMatch(rendered, /Available environments:/);
});
