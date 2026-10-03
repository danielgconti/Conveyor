import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';

interface FormState {
  image: string;
  input: string;
  cpu: string;
  memoryMb: string;
  timeout: string;
  maxRetries: string;
}

interface Preset {
  name: string;
  description: string;
  form: Partial<FormState>;
  sampleFile?: { path: string; name: string };
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const PRESETS: Preset[] = [
  {
    name: 'Count primes',
    description: 'CPU-bound sieve in Python',
    form: { image: 'conveyor/cpu-worker:latest', input: pretty({ number: 5_000_000 }) },
  },
  {
    name: 'Resize image',
    description: 'Pillow, with a sample photo',
    form: {
      image: 'conveyor/image-worker:latest',
      input: pretty({ imagePath: '/job/input/image.jpg', operation: 'resize', width: 500, height: 500 }),
    },
    sampleFile: { path: '/sample.jpg', name: 'image.jpg' },
  },
  {
    name: 'Sentiment (ML)',
    description: 'DistilBERT. Needs the ml profile',
    form: {
      image: 'conveyor/sentiment-worker:latest',
      input: pretty({ texts: ['This platform is fantastic!', 'The build broke again.'] }),
      memoryMb: '1536',
      timeout: '120',
    },
  },
  {
    name: 'Flaky job',
    description: 'Exits 1. Watch it retry',
    form: { image: 'conveyor/cpu-worker:latest', input: pretty({ number: 1000, exitCode: 1 }), maxRetries: '2' },
  },
  {
    name: 'Slow job',
    description: 'Sleeps 30s. Times out at 5s',
    form: { image: 'conveyor/cpu-worker:latest', input: pretty({ number: 1000, sleepSeconds: 30 }), timeout: '5' },
  },
];

const DEFAULT_FORM: FormState = {
  image: '',
  input: pretty({}),
  cpu: '1',
  memoryMb: '512',
  timeout: '60',
  maxRetries: '0',
};

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function SubmitJobPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM, ...PRESETS[0]!.form });
  const [files, setFiles] = useState<File[]>([]);
  const [activePreset, setActivePreset] = useState(PRESETS[0]!.name);

  let inputError: string | null = null;
  let parsedInput: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(form.input || '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) inputError = 'Input must be a JSON object';
    else parsedInput = value as Record<string, unknown>;
  } catch (e) {
    inputError = `Invalid JSON: ${(e as Error).message}`;
  }

  const submit = useMutation({
    mutationFn: async () => {
      const inputFiles = Object.fromEntries(
        await Promise.all(files.map(async (f) => [f.name, await readAsBase64(f)] as const)),
      );
      return api.createJob({
        image: form.image.trim(),
        input: parsedInput,
        inputFiles,
        resources: { cpu: Number(form.cpu), memory: `${form.memoryMb}m`, timeout: Number(form.timeout) },
        maxRetries: Number(form.maxRetries),
      });
    },
    onSuccess: ({ jobId }) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/jobs/${jobId}`);
    },
  });

  async function applyPreset(preset: Preset) {
    setActivePreset(preset.name);
    setForm({ ...DEFAULT_FORM, ...preset.form });
    setFiles([]);
    if (preset.sampleFile) {
      const blob = await (await fetch(preset.sampleFile.path)).blob();
      setFiles([new File([blob], preset.sampleFile.name, { type: blob.type })]);
    }
  }

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const error = submit.error;
  const issues = error instanceof ApiError ? error.issues : [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Submit job</h1>
          <p className="muted">
            Any image that reads <code>/job/input.json</code> and writes <code>/job/output.json</code> can run here.
          </p>
        </div>
      </div>

      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className={`preset ${activePreset === p.name ? 'active' : ''}`}
            onClick={() => void applyPreset(p)}
          >
            <strong>{p.name}</strong>
            <span>{p.description}</span>
          </button>
        ))}
      </div>

      <form
        className="panel form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!inputError) submit.mutate();
        }}
      >
        <label className="field">
          <span>Docker image</span>
          <input className="mono" value={form.image} onChange={set('image')} placeholder="my-worker:latest" required />
        </label>

        <label className="field">
          <span>
            Input JSON <small className="muted">written to /job/input.json</small>
          </span>
          <textarea className="mono" rows={8} value={form.input} onChange={set('input')} spellCheck={false} />
          {inputError && <small className="field-error">{inputError}</small>}
        </label>

        <label className="field">
          <span>
            Input files <small className="muted">copied to /job/input/</small>
          </span>
          <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          {files.length > 0 && (
            <small className="muted">
              {files.map((f) => `${f.name} (${Math.ceil(f.size / 1024)} KB)`).join(', ')}
            </small>
          )}
        </label>

        <div className="field-row">
          <label className="field">
            <span>CPU (cores)</span>
            <input type="number" min="0.1" step="0.1" value={form.cpu} onChange={set('cpu')} required />
          </label>
          <label className="field">
            <span>Memory (MB)</span>
            <input type="number" min="16" step="1" value={form.memoryMb} onChange={set('memoryMb')} required />
          </label>
          <label className="field">
            <span>Timeout (s)</span>
            <input type="number" min="1" step="1" value={form.timeout} onChange={set('timeout')} required />
          </label>
          <label className="field">
            <span>Max retries</span>
            <input type="number" min="0" step="1" value={form.maxRetries} onChange={set('maxRetries')} required />
          </label>
        </div>

        {error && (
          <div className="alert error">
            {error.message}
            {issues.length > 0 && (
              <ul>
                {issues.map((i) => (
                  <li key={i.path + i.message}>
                    <code>{i.path || '(body)'}</code>: {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="button primary" disabled={submit.isPending || !!inputError}>
            {submit.isPending ? 'Submitting…' : 'Submit job'}
          </button>
        </div>
      </form>
    </>
  );
}
