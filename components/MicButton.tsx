
import React from 'react';

interface MicButtonProps {
  isRecording: boolean;
  isLoading: boolean;
  onClick: () => void;
}

const MicButton: React.FC<MicButtonProps> = ({ isRecording, isLoading, onClick }) => {
  const buttonClasses = `
    p-4 rounded-full shadow-lg transition-all duration-300 ease-in-out
    focus:outline-none focus:ring-4
    ${isRecording
      ? 'bg-red-500 hover:bg-red-600 focus:ring-red-300'
      : 'bg-blue-500 hover:bg-blue-600 focus:ring-blue-300'}
    ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}
  `;

  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      className={buttonClasses}
      aria-label={isRecording ? 'Stop Recording' : 'Start Recording'}
    >
      {isLoading ? (
        <svg className="animate-spin h-6 w-6 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      ) : (
        <svg
          className="h-6 w-6 text-white"
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          {isRecording ? (
            <path d="M6 6h12v12H6z" /> // Stop icon (square)
          ) : (
            <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.2-3c0 3-2.54 5.1-5.2 5.1S6.8 14 6.8 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.8z" /> // Mic icon
          )}
        </svg>
      )}
    </button>
  );
};

export default MicButton;
