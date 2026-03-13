export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface ScanMetadata {
  coreVersion?: string;
  platformVersion?: string;
  scannerVersion?: string;
  timestamp: string;
  scanMode?: string;
  platform?: string;
}

export interface ScanInput {
  fileName: string;
  sizeBytes: number;
  sha256Hash?: string;
}

export interface ScanSummary {
  totalFindings: number;
  countBySeverity: Partial<Record<Severity, number>>;
  triggeredRules?: string[];
}

export interface DeveloperGuidance {
  ruleId?: string;
  ruleIds?: string[];
  remediation: string;
  documentationUrl?: string;
  alternativeApis?: string[];
  isRemediable?: boolean;
}

export interface CallChainNode {
  id?: string;
  nodeType: string;
  location: string;
  description?: string;
}

export interface CallChain {
  id?: string;
  nodes: CallChainNode[];
}

export interface DataFlowNode {
  id?: string;
  nodeType: string;
  location: string;
  description?: string;
}

export interface DataFlowChain {
  id?: string;
  pattern?: string;
  callDepth?: number;
  isSuspicious?: boolean;
  nodes?: DataFlowNode[];
}

export interface ThreatFamilyEvidence {
  kind: string;
  value: string;
  ruleId?: string;
  location?: string;
  callChainId?: string;
  dataFlowChainId?: string;
  pattern?: string;
  methodLocation?: string;
  confidence?: number;
}

export interface ThreatFamily {
  familyId: string;
  variantId: string;
  displayName: string;
  summary: string;
  matchKind: string;
  confidence: number;
  exactHashMatch: boolean;
  matchedRules: string[];
  advisorySlugs: string[];
  evidence: ThreatFamilyEvidence[];
}

export interface Finding {
  id?: string;
  ruleId?: string;
  description: string;
  severity: Severity;
  location?: string;
  codeSnippet?: string;
  riskScore?: number;
  developerGuidance?: DeveloperGuidance;
  callChainId?: string;
  dataFlowChainId?: string;
  callChain?: CallChain;
  dataFlowChain?: DataFlowChain;
}

export interface ScanResult {
  schemaVersion: string;
  metadata: ScanMetadata;
  input: ScanInput;
  summary: ScanSummary;
  findings: Finding[];
  callChains?: CallChain[];
  dataFlows?: DataFlowChain[];
  developerGuidance?: DeveloperGuidance[];
  threatFamilies?: ThreatFamily[];
}
