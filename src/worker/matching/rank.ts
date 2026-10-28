export type MatchRank = {
  departmentPriority: boolean;
  timeDifference: number;
  createdAt: number;
  id: string;
};

export function compareMatchRank(a: MatchRank, b: MatchRank) {
  return Number(b.departmentPriority) - Number(a.departmentPriority)
    || a.timeDifference - b.timeDifference
    || a.createdAt - b.createdAt
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function matchReasons(sameDepartment: boolean) {
  return sameDepartment ? ['SAME_DEPARTMENT', 'DEPARTURE_TIME'] as const : ['DEPARTURE_TIME'] as const;
}
