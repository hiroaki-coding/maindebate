import type { InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  error?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, error, className = '', ...props }, ref) => {
    return (
      <div className="w-full">
        <label className="flex items-start gap-3 cursor-pointer">
          <div className="relative flex-shrink-0 mt-0.5">
            <input
              ref={ref}
              type="checkbox"
              className={`
                w-5 h-5 rounded border-2 cursor-pointer
                appearance-none bg-white transition-colors duration-200
                checked:bg-primary checked:border-primary
                focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2
                ${error ? 'border-error' : 'border-border-color'}
                ${className}
              `}
              {...props}
            />
            <svg
              className="absolute top-0.5 left-0.5 w-4 h-4 text-white pointer-events-none opacity-0 peer-checked:opacity-100"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          {label && (
            <span className="text-sm text-text-primary leading-relaxed">{label}</span>
          )}
        </label>
        {error && (
          <p className="mt-1.5 text-sm text-error ml-8">{error}</p>
        )}
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';
