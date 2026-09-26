import type { RoutingPolicy } from './routing-policy';
import type { Dataset } from '@/eval/schema';
// Experimental extension point only. No trained artifact or invented labels.
export interface LearnedRouterArtifact {
  version: string; datasetVersion: string; reviewedCaseIds: string[];
  featureNames: string[]; coefficients: number[]; intercept: number;
}
export interface LearnedRouterExperiment {
  train(dataset: Dataset): Promise<LearnedRouterArtifact>;
  policy(artifact: LearnedRouterArtifact): RoutingPolicy;
}
export function reviewedTrainingCases(dataset: Dataset) {
  return dataset.cases.filter(c => c.reviewed && c.reviewer && c.reviewed_at);
}
