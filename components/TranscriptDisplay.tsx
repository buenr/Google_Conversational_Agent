
import React, { useEffect, useRef } from 'react';
import { ChatMessage, Speaker } from '../types';

interface TranscriptDisplayProps {
  messages: ChatMessage[];
}

const TranscriptDisplay: React.FC<TranscriptDisplayProps> = ({ messages }) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  return (
    <div className="flex-grow overflow-y-auto p-4 bg-gray-50 rounded-md border border-gray-200">
      {messages.length === 0 ? (
        <p className="text-gray-500 text-center italic">Start the interview to begin the conversation.</p>
      ) : (
        messages.map((message) => (
          <div
            key={message.id}
            className={`flex mb-2 ${
              message.speaker === Speaker.USER ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`max-w-[80%] p-3 rounded-lg shadow-sm ${
                message.speaker === Speaker.USER
                  ? 'bg-blue-100 text-blue-800'
                  : message.speaker === Speaker.MODEL
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-200 text-gray-700'
              }`}
            >
              <p className="font-semibold text-sm mb-1 capitalize">
                {message.speaker === Speaker.USER ? 'You' : message.speaker}:
              </p>
              <p className={`text-base ${message.isPartial ? 'italic text-gray-500' : ''}`}>
                {message.text}
              </p>
            </div>
          </div>
        ))
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default TranscriptDisplay;
