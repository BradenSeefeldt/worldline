// Pasted code is recognised as code (a code block, not headings made of comments); notes stay notes.
import { describe, expect, it } from 'vitest';
import { guessLanguage, looksLikeCode } from './CodeBlock';

describe('pasted text: code or notes?', () => {
  it('code: Python, a terminal session, shell commands, C, Fortran, an IPython session', () => {
    expect(looksLikeCode('import numpy as np\n\n# load the run\ndef load(path):\n    return np.load(path)')).toBe(true);
    expect(looksLikeCode('$ conda activate CLAUDE\n$ squeue -u $USER\n  JOBID PARTITION\n  12345 gpu')).toBe(true);
    expect(looksLikeCode('cd ~/runs/big\nsbatch run.sh\ngit pull')).toBe(true);
    expect(looksLikeCode('int main(void) {\n  printf("hi");\n  return 0;\n}')).toBe(true);
    expect(looksLikeCode('program flux\n  implicit none\n  real :: b\nend program')).toBe(true);
    expect(looksLikeCode('In [3]: x = np.arange(10)\nIn [4]: x.mean()')).toBe(true);
  });
  it('notes: a markdown list, checklists, ordinary sentences, one line', () => {
    expect(looksLikeCode('- email Jordan\n- book the flight')).toBe(false);
    expect(looksLikeCode('[] reply to Sam\n[] renew the library books')).toBe(false);
    expect(looksLikeCode('Notes from the meeting:\nwe should rerun with a = 0.94\nand check the flux')).toBe(false);
    expect(looksLikeCode('conda activate CLAUDE')).toBe(false); // (one line: inline `code` is for that)
  });
});

describe('which language, when none is chosen', () => {
  it('Python and a terminal session are told apart (never "INI" for Python)', () => {
    expect(guessLanguage('import numpy as np\n\n# one snapshot\ndef load(path, field="rho"):\n    data = np.load(path)\n    return data[field]')).toBe('python');
    expect(guessLanguage('$ ssh cluster\n$ cd ~/runs/big && sbatch run.sh\nSubmitted batch job 4815162')).toBe('shell');
  });
});
