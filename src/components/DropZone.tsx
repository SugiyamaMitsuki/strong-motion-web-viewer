import { useRef, useState } from 'react';

interface DropZoneProps {
  onFiles: (files: File[]) => void;
  loading?: boolean;
}

interface FileSystemFileHandleLike {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}

interface FileSystemDirectoryHandleLike {
  kind: 'directory';
  name: string;
  values: () => AsyncIterable<FileSystemHandleLike>;
}

type FileSystemHandleLike = FileSystemFileHandleLike | FileSystemDirectoryHandleLike;

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike>;
}

function withRelativeName(file: File, relativeName: string): File {
  return new File([file], relativeName, { type: file.type, lastModified: file.lastModified });
}

async function readDirectoryFiles(handle: FileSystemDirectoryHandleLike, basePath = ''): Promise<File[]> {
  const files: File[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      files.push(withRelativeName(file, `${basePath}${file.name}`));
    } else {
      const childFiles = await readDirectoryFiles(entry, `${basePath}${entry.name}/`);
      files.push(...childFiles);
    }
  }
  return files;
}

export function DropZone({ onFiles, loading = false }: DropZoneProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const openDirectory = async (): Promise<void> => {
    const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
    if (!picker) {
      alert('This browser does not support the directory picker API. Use file selection or drag and drop instead.');
      return;
    }
    const handle = await picker.call(window);
    const files = await readDirectoryFiles(handle);
    onFiles(files);
  };

  return (
    <section
      className={`drop-zone ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
    >
      <div>
        <h2>Import Files</h2>
        <p>Drag and drop K-NET / KiK-net, CSV, or manually configured text waveform data.</p>
        <p className="note">Browsers cannot read arbitrary local path strings directly. Use file selection, folder selection, or drag and drop.</p>
      </div>
      <div className="button-row">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={loading}>Select Files</button>
        <button type="button" onClick={() => void openDirectory()} disabled={loading}>Select Folder</button>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden-input"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (files.length > 0) onFiles(files);
          event.currentTarget.value = '';
        }}
      />
    </section>
  );
}
