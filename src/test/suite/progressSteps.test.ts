import * as assert from 'assert';
import { formatStepMessage } from '../../progressSteps';

describe('progressSteps', () => {
    it('formats as Step i/N with intent', () => {
        assert.strictEqual(formatStepMessage(1, 7, 'Load patch'), 'Step 1/7: Load patch');
        assert.strictEqual(
            formatStepMessage(3, 7, 'Build preview', 'trying blobs'),
            'Step 3/7: Build preview — trying blobs'
        );
    });

    it('bounds step to [1, totalSteps]', () => {
        assert.strictEqual(formatStepMessage(0, 5, 'Work'), 'Step 1/5: Work');
        assert.strictEqual(formatStepMessage(99, 5, 'Work'), 'Step 5/5: Work');
    });
});
