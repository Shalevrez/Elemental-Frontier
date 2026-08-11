/**
 * Adaptive tutorial. The step list depends on the rolled affinity and the
 * world mode, so a Stone Adept is never told about water, only Convergence
 * learns to switch, and a peaceful world explains motes instead of guardians.
 */

import type { AffinityId, ElementId } from '../elements/affinity';
import { ELEMENTS } from '../elements/elements';
import type { WorldMode } from '../world/shrineData';

export interface TutorialTracker {
  distanceMoved: number;
  jumped: boolean;
  sprinted: boolean;
  primaryUsed: boolean;
  secondaryUsed: boolean;
  terrainDug: number;
  terrainAdded: number;
  terrainModeUsed: boolean;
  healingUsed: boolean;
  elementSwitches: number;
  shrineCleansed: boolean;
}

export function createTracker(): TutorialTracker {
  return {
    distanceMoved: 0,
    jumped: false,
    sprinted: false,
    primaryUsed: false,
    secondaryUsed: false,
    terrainDug: 0,
    terrainAdded: 0,
    terrainModeUsed: false,
    healingUsed: false,
    elementSwitches: 0,
    shrineCleansed: false,
  };
}

export interface TutorialStepDef {
  text: string;
  isDone(t: TutorialTracker): boolean;
}

export function tutorialTitle(affinity: AffinityId): string {
  return affinity === 'convergence' ? 'Convergence training' : `${ELEMENTS[affinity as ElementId].adept} training`;
}

export function buildTutorial(affinity: AffinityId, active: ElementId, mode: WorldMode): TutorialStepDef[] {
  const el = ELEMENTS[active];
  const steps: TutorialStepDef[] = [
    {
      text: 'Move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> and look with the mouse.',
      isDone: (t) => t.distanceMoved > 12,
    },
    {
      text: 'Sprint with <kbd>Shift</kbd>, jump with <kbd>Space</kbd>.',
      isDone: (t) => t.jumped && t.sprinted,
    },
  ];

  if (affinity === 'convergence') {
    steps.push({
      text: 'Hold one element at a time: <kbd>1</kbd> Air, <kbd>2</kbd> Water, <kbd>3</kbd> Earth, <kbd>4</kbd> Fire. Switch at least twice.',
      isDone: (t) => t.elementSwitches >= 2,
    });
    steps.push({
      text: 'Fire the held element&rsquo;s primary with <kbd>LMB</kbd> and its secondary with <kbd>RMB</kbd>.',
      isDone: (t) => t.primaryUsed && t.secondaryUsed,
    });
  } else {
    steps.push({
      text: `<b>${el.primary.name}</b> - <kbd>LMB</kbd>. ${stripTags(el.primary.blurb)}`,
      isDone: (t) => t.primaryUsed,
    });
    steps.push({
      text: `<b>${el.secondary.name}</b> - <kbd>RMB</kbd>. ${stripTags(el.secondary.blurb)}`,
      isDone: (t) => t.secondaryUsed,
    });
  }

  steps.push(
    {
      text: 'Press <kbd>Tab</kbd> for Terrain Mode. Dig with <kbd>LMB</kbd>, build the ground back with <kbd>RMB</kbd>.',
      isDone: (t) => t.terrainModeUsed && t.terrainDug > 0 && t.terrainAdded > 0,
    },
    {
      text: 'Resize the brush with <kbd>[</kbd> and <kbd>]</kbd>, pick a material with the mouse wheel, hold <kbd>Shift</kbd> for fine control.',
      isDone: (t) => t.terrainDug > 3,
    },
    {
      text: 'Hurt? Press <kbd>H</kbd> for the best healing item, or open the satchel with <kbd>I</kbd>. Rest at a campfire with <kbd>E</kbd>.',
      isDone: (t) => t.healingUsed,
    },
    {
      text: mode === 'peaceful'
        ? 'Follow the compass to a shrine, gather its three elemental motes with <kbd>E</kbd>, then return and hold <kbd>E</kbd> to cleanse it.'
        : 'Follow the compass to a blighted shrine. Fell its guardian, then hold <kbd>E</kbd> to cleanse it.',
      isDone: (t) => t.shrineCleansed,
    },
  );

  return steps;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}
