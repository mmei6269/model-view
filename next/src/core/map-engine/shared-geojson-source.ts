// Pure shared-source lifecycle used by the MapLibre engine. Keeping this
// coordinator independent of maplibre-gl makes the important source-count and
// setData de-duplication semantics cheap to test in Node.

export interface SharedGeoJsonSourceHost {
  addSource(id: string, data: GeoJSON.FeatureCollection): void;
  setData(id: string, data: GeoJSON.FeatureCollection): void;
  removeSource(id: string): void;
}

interface SharedGeoJsonSourceEntry {
  added: boolean;
  data: GeoJSON.FeatureCollection;
  members: Set<string>;
  // Members that have reported the current data identity. A family may move
  // to a new collection only after every member completed the previous pass;
  // this turns accidental mixed collections into a deterministic error
  // instead of last-writer-wins geometry corruption.
  seenMembers: Set<string>;
}

const SHARED_GEOJSON_SOURCE_PREFIX = "wx-geojson:";

export function sharedGeoJsonSourceId(family: string): string {
  return `${SHARED_GEOJSON_SOURCE_PREFIX}${family}`;
}

// Test introspection historically reports the feature roster visible to each
// symbol layer. Shared sources carry every class, so evaluate the ordinary
// filter-expression subset used by app layers rather than inflating each
// layer's count to the family's full collection.
export function countFilteredGeoJsonFeatures(data: GeoJSON.FeatureCollection, filter: unknown[] | undefined): number {
  if (!filter) {
    return data.features.length;
  }
  return data.features.filter((feature) => Boolean(evalFilterExpression(filter, feature.properties || {}))).length;
}

function evalFilterExpression(expression: unknown, properties: GeoJSON.GeoJsonProperties): unknown {
  if (!Array.isArray(expression)) {
    return expression;
  }
  const [operator, ...operands] = expression;
  if (operator === "get") {
    return properties?.[String(operands[0])];
  }
  if (operator === "has") {
    return Object.prototype.hasOwnProperty.call(properties || {}, String(operands[0]));
  }
  if (operator === "!") {
    return !evalFilterExpression(operands[0], properties);
  }
  if (operator === "all") {
    return operands.every((operand) => Boolean(evalFilterExpression(operand, properties)));
  }
  if (operator === "any") {
    return operands.some((operand) => Boolean(evalFilterExpression(operand, properties)));
  }
  const left = evalFilterExpression(operands[0], properties);
  const right = evalFilterExpression(operands[1], properties);
  if (operator === "==") {
    return left === right;
  }
  if (operator === "!=") {
    return left !== right;
  }
  if (operator === ">") {
    return Number(left) > Number(right);
  }
  if (operator === ">=") {
    return Number(left) >= Number(right);
  }
  if (operator === "<") {
    return Number(left) < Number(right);
  }
  if (operator === "<=") {
    return Number(left) <= Number(right);
  }
  return false;
}

export class SharedGeoJsonSourceRegistry {
  private readonly entries = new Map<string, SharedGeoJsonSourceEntry>();

  attach(
    family: string,
    member: string,
    data: GeoJSON.FeatureCollection,
    host: SharedGeoJsonSourceHost | null,
  ): string {
    let entry = this.entries.get(family);
    if (!entry) {
      entry = { added: false, data, members: new Set(), seenMembers: new Set() };
      this.entries.set(family, entry);
    } else if (entry.data !== data) {
      if (!entry.members.has(member) || entry.seenMembers.size !== entry.members.size) {
        throw new Error(
          `Shared GeoJSON source family ${family} received conflicting FeatureCollection references in one update pass.`,
        );
      }
      entry.data = data;
      entry.seenMembers.clear();
      if (entry.added && host) {
        host.setData(sharedGeoJsonSourceId(family), data);
      }
    }
    entry.members.add(member);
    entry.seenMembers.add(member);
    if (!entry.added && host) {
      host.addSource(sharedGeoJsonSourceId(family), entry.data);
      entry.added = true;
    }
    return sharedGeoJsonSourceId(family);
  }

  ensure(family: string, host: SharedGeoJsonSourceHost): string {
    const entry = this.entries.get(family);
    if (!entry) {
      throw new Error(`Shared GeoJSON source family ${family} has no registered members.`);
    }
    if (!entry.added) {
      host.addSource(sharedGeoJsonSourceId(family), entry.data);
      entry.added = true;
    }
    return sharedGeoJsonSourceId(family);
  }

  release(family: string, member: string, host: SharedGeoJsonSourceHost | null): void {
    const entry = this.entries.get(family);
    if (!entry) {
      return;
    }
    entry.members.delete(member);
    entry.seenMembers.delete(member);
    if (entry.members.size > 0) {
      return;
    }
    if (entry.added && host) {
      host.removeSource(sharedGeoJsonSourceId(family));
    }
    this.entries.delete(family);
  }

  markUnadded(): void {
    for (const entry of this.entries.values()) {
      entry.added = false;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  // TEST-ONLY count: the registry is intentionally otherwise opaque.
  size(): number {
    return this.entries.size;
  }
}
