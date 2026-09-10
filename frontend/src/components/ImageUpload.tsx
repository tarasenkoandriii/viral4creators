import React, { useState, useRef } from 'react';
import { ImagePlus } from 'lucide-react';
import { Alert, Button } from './ui';
import { useI18n } from '../lib/i18n-context';

interface ImageUploadProps {
  onImageSelect: (file: File) => void;
  onUpload: () => void;
  uploadProgress?: number;
  previewUrl?: string | null;
  error?: string;
  disabled?: boolean;
}

/**
 * ImageUpload component for product image upload with preview
 */
export const ImageUpload: React.FC<ImageUploadProps> = ({
  onImageSelect,
  onUpload,
  uploadProgress,
  previewUrl,
  error,
  disabled = false,
}) => {
  const { dict } = useI18n();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setLocalError(dict.imageUpload.invalidType);
      return;
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      setLocalError(dict.imageUpload.tooLarge);
      return;
    }

    setLocalError(null);
    setSelectedFile(file);
    onImageSelect(file);
  };

  const handleUploadClick = () => {
    if (selectedFile) {
      onUpload();
    }
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const shownError = error || localError;

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-silver-300 dark:border-silver-700 p-5">
        {previewUrl ? (
          <div className="w-full space-y-2">
            <img
              src={previewUrl}
              alt={dict.imageUpload.previewAlt}
              className="mx-auto max-h-64 max-w-full rounded-lg object-contain"
            />
            <p className="text-center text-xs text-silver-400 truncate">
              {selectedFile?.name}
            </p>
          </div>
        ) : (
          <div className="space-y-1 text-center">
            <ImagePlus size={28} className="mx-auto text-silver-400" />
            <p className="text-sm">{dict.imageUpload.heading}</p>
            <p className="text-xs text-silver-400">
              {dict.imageUpload.formatsHint}
            </p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handleFileChange}
          className="hidden"
          disabled={disabled}
        />

        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBrowseClick}
            disabled={disabled}
          >
            {previewUrl
              ? dict.imageUpload.changePhoto
              : dict.imageUpload.choose}
          </Button>
          {selectedFile && !uploadProgress && (
            <Button size="sm" onClick={handleUploadClick} disabled={disabled}>
              {dict.imageUpload.upload}
            </Button>
          )}
        </div>
      </div>

      {uploadProgress !== undefined &&
        uploadProgress > 0 &&
        uploadProgress < 100 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-silver-400">
              <span>{dict.imageUpload.uploading}</span>
              <span className="tabular">{uploadProgress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-silver-200/60 dark:bg-silver-800/60">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

      {shownError && <Alert tone="error">{shownError}</Alert>}
    </div>
  );
};
