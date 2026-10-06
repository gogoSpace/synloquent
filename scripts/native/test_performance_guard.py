"""These negatives test the gate. They do not establish native compatibility."""
import copy
import unittest

from performance_guard import HTTP_RELATION_GROUPS, MANIFEST_MODELS, MANIFEST_PIVOTS, SNAPSHOT_PHASES, validate_measurement


def passing_witness():
    frames = {
        'elapsedMilliseconds': 8000,
        'firstFrameGapMilliseconds': 16,
        'finalFrameGapMilliseconds': 8,
        'maximumFrameGapMilliseconds': 17,
        'callbackCoverageRatio': 1,
        'estimatedMissedFrames': 0,
        'frames': 500,
    }
    catalog = {
        'records': [{'model': model, 'stored': {'Category': 50, 'Tag': 64, 'Item': 17001, 'Image': 100001}.get(model, 0), 'deleted':{'Item':1,'Image':6}.get(model,0), 'available':{'Category':50,'Tag':64,'Item':17000,'Image':99995}.get(model,0)} for model in MANIFEST_MODELS],
        'relationSets': 100,
        'pivotFamilies': [{'table':table, 'live':300 if table=='item_tag' else 0, 'canonical':300 if table=='item_tag' else 0} for table in MANIFEST_PIVOTS],
        'pivotRows': 300,
        'canonicalPivotRows': 300,
        'storedContentHash': 'a' * 64,
        'schemaHash': 'b' * 64,
    }
    pending = {
        'beforeOperationIds': ['create-operation', 'edit-operation', 'delete-operation'],
        'afterOperationIds': ['create-operation', 'edit-operation', 'delete-operation'],
        'beforeOutboxHash':'f'*64,'afterOutboxHash':'f'*64,
        'stableAliasBefore': 'stable-item-identity',
        'stableAliasAfter': 'stable-item-identity',
        'pendingCreateVisible': True,
        'pendingEditRetained': True,
        'pendingDeleteHidden': True,
        'pendingCascadeChildrenHidden': True,
    }
    hidden = {field: 0 for field in ['imageCount','tagCount','tagIdSum','parentTagCount','inverseCount','inverseQuantitySum','inverseWithCount','inverseWithSum']}
    hidden.update(parentVisible=False, tagIds=[], inverseItemIds=[])
    retained = {'fullOutboxHash':'f'*64, 'operationStatuses':[{'operationId':identity,'status':'pending'} for identity in pending['beforeOperationIds']], 'metadata':[{'key':key,'value':'retained-value'} for key in ['manifest','scope','snapshotGeneration','cursor:catalog']]}
    public_witness = {
        'hiddenPublicState':hidden,
        'restoredPublicState':{'parentId':'3','imageIds':sorted(['2','17002','34002','51002','68002','85002']),'imageCount':6,'imageParents':['3']*6,'tagIds':['4','5','6'],'inverseItemIds':['3'],'inverseCount':1,'inverseWithCount':1,'inverseWithSum':3,'deletionStatus':'cancelled'},
        'afterRollbackPublicState':copy.deepcopy(hidden), 'beforeCancellation':retained,'afterCancellation':copy.deepcopy(retained),
        'beforeCatalogHash':'a'*64,'afterCatalogHash':'a'*64,'rollbackSentinelObserved':True,
    }
    reference = {
        'rows': 117115,
        'elapsedMilliseconds': 8000,
        'bulkStatements': 1830,
        'sharedHelpers': ['DatabaseOwner transaction and pending preservation'],
        'phaseMeasurements': [{'phase': phase, 'elapsedMilliseconds': 1000} for phase in SNAPSHOT_PHASES],
        'actualCatalog': copy.deepcopy(catalog),
        'pendingPreservation': copy.deepcopy(pending),
        'frameMeasurement': copy.deepcopy(frames),
    }
    repeat = {
        'actualCatalog': copy.deepcopy(catalog),
        'pendingPreservation': copy.deepcopy(pending),
        'walAfterCheckpointBytes': 0,
        'checkpointMilliseconds': 2,
        'databaseBytes': 31272960,
        'elapsedMilliseconds': 8000,
        'frameMeasurement': copy.deepcopy(frames),
    }
    measurement = {
        'frameBudgetMilliseconds': 16,
        'importMilliseconds': 8000,
        'coldReadMilliseconds': 13,
        'warmReadMilliseconds': 3,
        'databaseBytes': 31272960,
        'maximumJavaScriptWorkMilliseconds': 4,
        'frameMeasurement': frames,
        'responsivenessMeasurement': {
            'boundary': 'native React RuntimeScheduler task after microtask checkpoint',
            'includesNativeSchedulingDelay': True,
            'callbacks': 500,
            'maximumCallbackGapMilliseconds': 4,
            'phaseMaximumGaps': [{'phase': 'digest', 'statement': 'native SHA256 continuation', 'wallMilliseconds': 4, 'callingThreadCpuMilliseconds': 2}],
        },
        'nativeBaselineResidentBytes': 160000000,
        'baselineMemoryBytes': 50000000,
        'peakMemoryBytes': 60000000,
        'phaseMeasurements': [{'phase': phase, 'elapsedMilliseconds': 1000} for phase in SNAPSHOT_PHASES],
        'actualCatalog': catalog,
        'pendingPreservation': pending,
        'fairReference': reference,
        'uiInteraction': {
            'driver': 'XCUITest native events',
            'phases': {phase: {'inputEvents': 2, 'scrollEvents': 2, 'maximumActionDeliveryMilliseconds': 20} for phase in ['idle', 'sdk-import', 'reference-import', 'large-http']},
        },
        'repeatedImports': [copy.deepcopy(repeat), copy.deepcopy(repeat)],
        'walLifecycle': {'peakWalBytes': 32000000, 'afterCheckpointWalBytes': 0, 'samples': 8, 'checkpointMilliseconds': 2},
        'invalidSnapshotRollback': {'sdkRejected': True, 'referenceRejected': True, 'beforeStoredHash': 'a' * 64, 'afterStoredHash': 'a' * 64, 'referenceAfterStoredHash': 'a' * 64},
        'batchSync': {'operations': 100, 'accepted': 100, 'actualHttp': True},
    }
    for side in ['sdk','reference']:
        for position in ['Before','After']:
            measurement['invalidSnapshotRollback'][side+'Metadata'+position]={'cursor':'retained-cursor','scope':'retained-scope','snapshotGeneration':'retained-generation'}
    measurement['largeHttp'] = {
        'actualHttp':True, 'completeInstall':True,
        'candidateFingerprint':'c'*64, 'packageArchiveSha256':'d'*64,'fixtureFingerprint':'e'*64,
        'serverSnapshotPreparationMilliseconds':2,'remainingResponseAvailabilityMilliseconds':2,
        'serverSnapshotPreparationBoundary':'Server-Timing snapshot preparation measured by PHP hrtime before streamed response body emission',
        'remainingResponseAvailabilityBoundary':'Complete React Native response availability minus snapshot preparation, including server body streaming, transport, native body buffering and scheduling',
        'elapsedMilliseconds':8000,'frameMeasurement':copy.deepcopy(frames),
        'phaseMeasurements':copy.deepcopy(reference['phaseMeasurements']),
        'httpStages':[{'kind':'snapshot','phase':phase,'elapsedMilliseconds':4,'heapBytes':60000000,**({'boundary':'complete response availability from React Native fetch'} if phase=='responseAvailable' else {}),**({'maximumWorkSliceMilliseconds':4} if phase in ('jsonDecode','shapeValidation') else {})} for phase in ['responseAvailable','responseText','jsonDecode','shapeValidation']],
        'actualCounts':{
            'models':[{'model':model,'records':{'Category':50,'Tag':64,'Item':17000,'Image':100001}.get(model,0)} for model in MANIFEST_MODELS],
            'relationSets':51128, 'relationTargets':600,
            'relationGroups':[{'group':group,**counts} for group,counts in HTTP_RELATION_GROUPS.items()],
            'pivotFamilies':[{'table':table,'live':300 if table=='item_tag' else 0,'canonical':300 if table=='item_tag' else 0} for table in MANIFEST_PIVOTS],
            'independentContentOracle':{
                'source':'deterministic PostgreSQL seed 20261002',
                'checkedRecords':117115,'checkedRelationSets':51128,'checkedTargets':600,
                'storedContentHash':'a'*64,'expectedContentHash':'a'*64,
                'independentContentMatches':True,'foreignKeysValid':True,'integrityValid':True,
            },
        },
        'baselineMemoryBytes':50000000,'peakMemoryBytes':60000000,
    }
    measurement['pendingDeletePublicWitness'] = copy.deepcopy(public_witness)
    reference['pendingDeletePublicWitness'] = copy.deepcopy(public_witness)
    for repeated in measurement['repeatedImports']:
        repeated['pendingDeletePublicWitness'] = copy.deepcopy(public_witness)
    reference['responsivenessMeasurement'] = copy.deepcopy(measurement['responsivenessMeasurement'])
    measurement['largeHttp']['responsivenessMeasurement'] = copy.deepcopy(measurement['responsivenessMeasurement'])
    for repeated in measurement['repeatedImports']:
        repeated['responsivenessMeasurement'] = copy.deepcopy(measurement['responsivenessMeasurement'])
    return measurement, {'nativeMemory': {'peakResidentBytes': 200000000}, 'candidateFingerprint':'c'*64,'packageArchiveWitness':{'sha256':'d'*64},'largeHttpFixture':{'fingerprint':'e'*64},'completedLargeFixtureFingerprint':'e'*64}


class PerformanceGuardTests(unittest.TestCase):
    def assert_rejected(self, change):
        measurement, evidence = passing_witness()
        change(measurement, evidence)
        self.assertTrue(validate_measurement(measurement, evidence))

    def test_complete_comparable_witness(self):
        self.assertEqual(validate_measurement(*passing_witness()), [])

    def test_retained_physical_membership_requires_public_delete_cancel_and_atomic_rollback_oracle(self):
        for scope in ('sdk', 'reference', 'repeat'):
            for mutation in ('missing', 'visible', 'inverse', 'aggregate', 'restore', 'status', 'metadata', 'hash', 'sentinel'):
                with self.subTest(scope=scope, mutation=mutation):
                    measurement, evidence = passing_witness()
                    target = measurement if scope == 'sdk' else measurement['fairReference'] if scope == 'reference' else measurement['repeatedImports'][0]
                    witness = target['pendingDeletePublicWitness']
                    if mutation == 'missing': target.pop('pendingDeletePublicWitness')
                    elif mutation == 'visible': witness['hiddenPublicState']['parentVisible'] = True
                    elif mutation == 'inverse': witness['hiddenPublicState']['inverseItemIds'] = ['3']
                    elif mutation == 'aggregate': witness['hiddenPublicState']['inverseWithSum'] = 3
                    elif mutation == 'restore': witness['restoredPublicState']['tagIds'].pop()
                    elif mutation == 'status': witness['afterCancellation']['operationStatuses'][0]['status'] = 'cancelled'
                    elif mutation == 'metadata': witness['afterCancellation']['metadata'][0]['value'] = 'changed'
                    elif mutation == 'hash': witness['afterCatalogHash'] = 'c'*64
                    elif mutation == 'sentinel': witness['rollbackSentinelObserved'] = False
                    self.assertTrue(validate_measurement(measurement, evidence))
        measurement, evidence = passing_witness()
        measurement['actualCatalog'].update(relationSets=99, pivotRows=297, canonicalPivotRows=297)
        self.assertTrue(validate_measurement(measurement, evidence))

    def test_missing_comparable_baseline(self):
        self.assert_rejected(lambda measurement, _: measurement.pop('fairReference'))

    def test_truncated_frame_interval(self):
        self.assert_rejected(lambda measurement, _: measurement['frameMeasurement'].update(elapsedMilliseconds=4000))

    def test_missing_first_and_final_frame_gaps(self):
        self.assert_rejected(lambda measurement, _: measurement['frameMeasurement'].pop('firstFrameGapMilliseconds'))
        self.assert_rejected(lambda measurement, _: measurement['frameMeasurement'].pop('finalFrameGapMilliseconds'))

    def test_incomplete_frame_coverage_and_missed_frames(self):
        self.assert_rejected(lambda measurement, _: measurement['frameMeasurement'].update(callbackCoverageRatio=0.5))
        self.assert_rejected(lambda measurement, _: measurement['frameMeasurement'].update(estimatedMissedFrames=1))

    def test_pending_payload_or_metadata_corruption(self):
        self.assert_rejected(lambda measurement, _: measurement['pendingPreservation'].update(afterOutboxHash='a'*64))
        self.assert_rejected(lambda measurement, _: measurement['invalidSnapshotRollback']['sdkMetadataAfter'].update(snapshotGeneration='wrong-generation'))

    def test_nonfinite_and_malformed_evidence(self):
        self.assert_rejected(lambda measurement, _: measurement.update(importMilliseconds=float('nan')))
        self.assert_rejected(lambda measurement, _: measurement.update(actualCatalog=[]))
        self.assert_rejected(lambda measurement, _: measurement.update(frameMeasurement=None))
        self.assert_rejected(lambda measurement, _: measurement['repeatedImports'].append(None))

    def test_fixture_constants_without_committed_counts(self):
        self.assert_rejected(lambda measurement, _: measurement['actualCatalog'].pop('records'))

    def test_missing_delivered_native_ui_events(self):
        self.assert_rejected(lambda measurement, _: measurement['uiInteraction']['phases']['sdk-import'].update(inputEvents=0))
        self.assert_rejected(lambda measurement, _: measurement['uiInteraction']['phases']['reference-import'].update(scrollEvents=0))

    def test_ui_hundred_second_delay_and_idle_regression(self):
        self.assert_rejected(lambda measurement, _: measurement['uiInteraction']['phases']['sdk-import'].update(maximumActionDeliveryMilliseconds=100000))
        self.assert_rejected(lambda measurement, _: measurement['uiInteraction']['phases']['reference-import'].update(maximumActionDeliveryMilliseconds=100))

    def test_missing_empty_model_family(self):
        self.assert_rejected(lambda measurement, _: measurement['actualCatalog']['records'].pop())

    def test_missing_phase_identity_and_nonfinite_gap(self):
        self.assert_rejected(lambda measurement, _: measurement['phaseMeasurements'].pop())
        self.assert_rejected(lambda measurement, _: measurement['responsivenessMeasurement']['phaseMaximumGaps'][0].update(callingThreadCpuMilliseconds=float('nan')))

    def test_baseline_clears_pending_guarantees(self):
        self.assert_rejected(lambda measurement, _: measurement['fairReference']['pendingPreservation'].update(afterOperationIds=[]))

    def test_new_snapshot_children_cannot_escape_pending_parent_delete(self):
        measurement, evidence = passing_witness()
        for catalog in [measurement['actualCatalog'], measurement['fairReference']['actualCatalog']]:
            image = next(row for row in catalog['records'] if row['model'] == 'Image')
            image.update(deleted=1, available=100000)
        for repeat in measurement['repeatedImports']:
            repeat['actualCatalog'] = copy.deepcopy(measurement['actualCatalog'])
        self.assertEqual(validate_measurement(measurement,evidence), ['Missing independent deleted and available SQL count for Image'])

    def test_baseline_stores_different_content(self):
        self.assert_rejected(lambda measurement, _: measurement['fairReference']['actualCatalog'].update(storedContentHash='c' * 64))

    def test_repeated_import_leaks_wal(self):
        self.assert_rejected(lambda measurement, _: measurement['repeatedImports'][0].update(walAfterCheckpointBytes=4096))

    def test_negative_snapshot_does_not_prove_rollback(self):
        self.assert_rejected(lambda measurement, _: measurement['invalidSnapshotRollback'].update(afterStoredHash='c' * 64))

    def test_missing_large_http_path(self):
        self.assert_rejected(lambda measurement, _: measurement.pop('largeHttp'))

    def test_malformed_failed_or_wrong_large_http_provenance(self):
        self.assert_rejected(lambda measurement, _: measurement.update(largeHttp=None))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp'].update(completeInstall=False))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp'].update(fixtureFingerprint='f'*64))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp'].update(packageArchiveSha256='f'*64))

    def test_large_http_truncated_frames_and_missing_native_ui(self):
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['frameMeasurement'].update(elapsedMilliseconds=4000))
        self.assert_rejected(lambda measurement, _: measurement['uiInteraction']['phases']['large-http'].update(inputEvents=0))

    def test_large_http_missing_phase_and_unbounded_parse(self):
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['httpStages'].pop())
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['httpStages'][2].update(elapsedMilliseconds=400, maximumWorkSliceMilliseconds=400))
        measurement, evidence = passing_witness()
        measurement['largeHttp']['httpStages'][0].pop('boundary')
        self.assertEqual(validate_measurement(measurement, evidence), ['Large HTTP lacks the actual installed React Native response availability boundary'])

    def test_http_cooperative_work_slices_preserve_complete_wall_and_fail_closed(self):
        measurement, evidence = passing_witness()
        for stage in measurement['largeHttp']['httpStages']:
            if stage['phase'] in ('jsonDecode', 'shapeValidation'):
                stage['elapsedMilliseconds'] = 400
                stage['maximumWorkSliceMilliseconds'] = 4
        self.assertEqual(validate_measurement(measurement, evidence), [])
        for phase_position in (2, 3):
            for value in (None, float('nan'), float('inf'), -1, True, 17, 400):
                with self.subTest(phase_position=phase_position, maximumWorkSlice=value):
                    mutated = copy.deepcopy(measurement)
                    if value is None:
                        mutated['largeHttp']['httpStages'][phase_position].pop('maximumWorkSliceMilliseconds')
                    else:
                        mutated['largeHttp']['httpStages'][phase_position]['maximumWorkSliceMilliseconds'] = value
                    self.assertTrue(validate_measurement(mutated, evidence))
        # A small self-reported slice never excuses independently observed blocking.
        measurement['largeHttp']['responsivenessMeasurement']['maximumCallbackGapMilliseconds'] = 400
        self.assertTrue(validate_measurement(measurement, evidence))
        measurement, evidence = passing_witness()
        measurement['largeHttp']['frameMeasurement']['maximumFrameGapMilliseconds'] = 400
        self.assertTrue(validate_measurement(measurement, evidence))

    def test_large_http_partial_relation_family_with_other_valid_evidence(self):
        measurement, evidence = passing_witness()
        measurement['largeHttp']['actualCounts']['relationGroups'][0]['sets'] = 16999
        self.assertEqual(validate_measurement(measurement, evidence), ['Large HTTP relation membership families differ from the independent fixture'])
        measurement, evidence = passing_witness()
        measurement['largeHttp']['actualCounts']['relationSets'] = 51127
        self.assertEqual(validate_measurement(measurement, evidence), ['Missing actual complete large HTTP committed model and relation counts'])

    def test_large_http_server_timing_cannot_claim_complete_server_or_network_time(self):
        mutations = {
            'old field names': lambda large: (
                large.update(serverWorkMilliseconds=large.pop('serverSnapshotPreparationMilliseconds')),
                large.update(networkAndNativeDeliveryMilliseconds=large.pop('remainingResponseAvailabilityMilliseconds')),
            ),
            'old claims alongside accurate fields': lambda large: large.update(serverWorkMilliseconds=2, networkAndNativeDeliveryMilliseconds=2),
            'complete server claim': lambda large: large.update(serverSnapshotPreparationBoundary='Complete server request lifecycle including streamed response body emission'),
            'pure network claim': lambda large: large.update(remainingResponseAvailabilityBoundary='Network transport only'),
            'missing server boundary': lambda large: large.pop('serverSnapshotPreparationBoundary'),
            'missing response boundary': lambda large: large.pop('remainingResponseAvailabilityBoundary'),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                measurement, evidence = passing_witness()
                self.assertEqual(validate_measurement(measurement, evidence), [])
                mutate(measurement['largeHttp'])
                self.assertEqual(validate_measurement(measurement, evidence), ['Large HTTP timing must distinguish snapshot preparation from remaining complete response availability'])

    def test_large_http_wrong_seed_content_or_memberships(self):
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['actualCounts']['independentContentOracle'].update(expectedContentHash='f'*64))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['actualCounts'].update(relationTargets=599))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['actualCounts']['pivotFamilies'][0].update(live=1))
        self.assert_rejected(lambda _, evidence: evidence.update(completedLargeFixtureFingerprint='f'*64))

    def test_missing_or_excessive_reference_repeat_and_http_callbacks(self):
        self.assert_rejected(lambda measurement, _: measurement['fairReference'].pop('responsivenessMeasurement'))
        self.assert_rejected(lambda measurement, _: measurement['repeatedImports'][0]['responsivenessMeasurement'].update(maximumCallbackGapMilliseconds=100))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp'].pop('responsivenessMeasurement'))
        self.assert_rejected(lambda measurement, _: measurement['largeHttp']['responsivenessMeasurement']['phaseMaximumGaps'][0].update(wallMilliseconds=100))

    def test_excessive_sdk_overhead(self):
        measurement,evidence=passing_witness()
        measurement['fairReference']['elapsedMilliseconds']=4000
        measurement['fairReference']['frameMeasurement']['elapsedMilliseconds']=4000
        measurement['fairReference']['frameMeasurement']['frames']=250
        self.assertEqual(validate_measurement(measurement,evidence), ['SDK overhead exceeds the declared comparison guard'])


if __name__ == '__main__':
    unittest.main()
