export type Gender = 'MAN' | 'WOMAN' | 'NON_BINARY' | 'UNDISCLOSED';
export type GenderFilter = 'ANY' | 'MAN' | 'WOMAN' | 'SAME_AS_ME';

export type MatchMember = { gender: Gender; filter: GenderFilter };

export function genderAllows(filter: GenderFilter, ownerGender: Gender, otherGender: Gender): boolean {
  if (filter === 'ANY') return true;
  if (ownerGender === 'UNDISCLOSED' || otherGender === 'UNDISCLOSED') return false;
  if (filter === 'SAME_AS_ME') return ownerGender === otherGender;
  return otherGender === filter;
}

export function genderGroupAllows(members: MatchMember[]): boolean {
  return members.every((member, index) => members.slice(index + 1).every((other) =>
    genderAllows(member.filter, member.gender, other.gender)
      && genderAllows(other.filter, other.gender, member.gender)));
}
