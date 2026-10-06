"""Independent expected content for the deterministic native HTTP catalog."""

import hashlib
import json
from collections import Counter

EXPECTED_RECORD_COUNTS = {
    'Category': 50, 'CollectionEntry': 0, 'Country': 0, 'ExternalRecord': 0,
    'Image': 100001, 'Item': 17000, 'ItemType': 0, 'Location': 0, 'Note': 0,
    'Salespoint': 0, 'Series': 0, 'Tag': 64, 'UlidRecord': 0, 'UuidRecord': 0,
}
EXPECTED_RELATION_COUNTS = {
    'Item.classifications': {'sets': 17000, 'targets': 0},
    'Item.salespoints': {'sets': 17000, 'targets': 0},
    'Item.tags': {'sets': 17000, 'targets': 300},
    'Tag.classifiedItems': {'sets': 64, 'targets': 0},
    'Tag.items': {'sets': 64, 'targets': 300},
}


def expected_attributes(model: str, identity: int) -> dict:
    attributes = {'id': identity, 'created_at': None, 'updated_at': None}
    if model in {'Category', 'Tag'}:
        return {**attributes, 'title': model + ' ' + str(identity)}
    if model == 'Image':
        return {**attributes, 'item_id': (identity % 17000) + 1,
                'url': 'image-20261002-' + str(identity) + '.jpg'}
    if model == 'Item':
        title = 'Synthetic item ' + str(identity).zfill(5)
        return {**attributes, 'category_id': (identity % 50) + 1, 'title': title,
                'price': str(identity % 10000) + '.' + str(identity % 100).zfill(2),
                'active': identity % 7 != 0, 'quantity': identity % 20,
                'metadata': None, 'labels': None, 'item_type_id': None,
                'series_id': None, 'location_id': None, 'status': 'draft',
                'catalog_code': None, 'published_on': None, 'released_at': None,
                'latitude': None, 'display_label': title + ' / draft'}
    raise ValueError('Unexpected populated fixture model ' + model)


def expected_targets(model: str, relation: str, parent_identity: int) -> list[dict]:
    if model == 'Item' and relation == 'tags' and parent_identity <= 100:
        return sorted([{'id': str(((parent_identity + position) % 64) + 1),
                        'attributes': {'position': position}}
                       for position in range(3)], key=lambda target: int(target['id']))
    if model == 'Tag' and relation == 'items':
        return [{'id': str(target_identity), 'attributes': {'position': position}}
                for target_identity in range(1, 101) for position in range(3)
                if ((target_identity + position) % 64) + 1 == parent_identity]
    return []


def validate_catalog(snapshot: dict) -> dict:
    counts = Counter()
    identities = set()
    local_identities = set()
    for record in snapshot['records']:
        model, raw_identity = record['model'], record['id']
        identity = int(raw_identity)
        if model not in EXPECTED_RECORD_COUNTS or str(identity) != raw_identity or not 1 <= identity <= EXPECTED_RECORD_COUNTS[model]:
            raise ValueError('Unexpected fixture record identity')
        if (model, raw_identity) in identities:
            raise ValueError('Duplicate fixture record identity')
        identities.add((model, raw_identity))
        counts[model] += 1
        expected = expected_attributes(model, identity)
        if json.dumps(record['attributes'], sort_keys=True) != json.dumps(expected, sort_keys=True):
            raise ValueError('Fixture attributes differ for ' + model + ':' + raw_identity)
        local_identity = record.get('localIdentity')
        if local_identity is not None:
            if not isinstance(local_identity, str) or not local_identity or local_identity in local_identities:
                raise ValueError('Invalid or duplicate supplied local identity')
            local_identities.add(local_identity)
        if record['revision'] != '0':
            raise ValueError('Unexpected untouched fixture revision')
    if {model: counts[model] for model in EXPECTED_RECORD_COUNTS} != EXPECTED_RECORD_COUNTS:
        raise ValueError('Fixture record families are incomplete')
    relation_counts = {name: {'sets': 0, 'targets': 0} for name in EXPECTED_RELATION_COUNTS}
    relation_identities = set()
    for relation_set in snapshot['relationSets']:
        model, relation = relation_set['model'], relation_set['relation']
        group = model + '.' + relation
        identity = int(relation_set['parentId'])
        relation_identity = (group, identity)
        if group not in EXPECTED_RELATION_COUNTS or str(identity) != relation_set['parentId'] or not 1 <= identity <= EXPECTED_RECORD_COUNTS[model] or relation_identity in relation_identities:
            raise ValueError('Unexpected or duplicate fixture relation identity')
        relation_identities.add(relation_identity)
        if relation_set['revision'] != '0' or relation_set['completeness'] != 'complete':
            raise ValueError('Fixture relation metadata changed')
        targets = expected_targets(model, relation, identity)
        if json.dumps(relation_set['targets'], sort_keys=True) != json.dumps(targets, sort_keys=True):
            raise ValueError('Fixture targets differ for ' + group + ':' + str(identity))
        relation_counts[group]['sets'] += 1
        relation_counts[group]['targets'] += len(targets)
    if relation_counts != EXPECTED_RELATION_COUNTS:
        raise ValueError('Fixture relation families are incomplete')
    canonical = json.dumps({'records': snapshot['records'], 'relationSets': snapshot['relationSets']},
                           sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    if snapshot['byteSize'] != len(canonical) or snapshot['hash'] != hashlib.sha256(canonical).hexdigest():
        raise ValueError('Canonical snapshot integrity differs')
    return {'recordCounts': EXPECTED_RECORD_COUNTS, 'relationCounts': relation_counts,
            'records': sum(EXPECTED_RECORD_COUNTS.values()),
            'relationSets': sum(group['sets'] for group in relation_counts.values()),
            'relationTargets': sum(group['targets'] for group in relation_counts.values()),
            'independentContentMatches': True}
