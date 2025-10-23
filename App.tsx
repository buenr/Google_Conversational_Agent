
import React, { useState, useEffect, useRef, useCallback } from 'react';
// Fix: Removed LiveStreamSession from import as it is not an exported member.
// The type is inferred from the `ai.live.connect()` method.
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ChatMessage, Speaker, VoiceOption, SavedTranscriptSession } from './types';
import { decode, decodeAudioData, encode, createBlob } from './utils/audioUtils';
import MicButton from './components/MicButton';
import TranscriptDisplay from './components/TranscriptDisplay';

// Define available AI voices
const availableVoices: VoiceOption[] = [
  { name: 'Zephyr', displayName: 'Zephyr (Default)' },
  { name: 'Puck', displayName: 'Puck' },
  { name: 'Charon', displayName: 'Charon' },
  { name: 'Kore', displayName: 'Kore' },
  { name: 'Fenrir', displayName: 'Fenrir' },
];

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('Press the mic to start the interview.');
  const [selectedVoice, setSelectedVoice] = useState<string>(availableVoices[0].name); // Default to the first voice

  const [savedTranscripts, setSavedTranscripts] = useState<SavedTranscriptSession[]>([]);
  const [showPastTranscripts, setShowPastTranscripts] = useState<boolean>(false);
  const [selectedPastTranscript, setSelectedPastTranscript] = useState<SavedTranscriptSession | null>(null);

  // Fix: Updated `useRef` type to correctly infer the return type of `ai.live.connect()`
  const liveSessionRef = useRef<ReturnType<GoogleGenAI['live']['connect']> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputAudioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const currentInputTranscriptionRef = useRef<string>('');
  const currentOutputTranscriptionRef = useRef<string>('');
  const lastUserMessageIdRef = useRef<string>('');
  const lastModelMessageIdRef = useRef<string>('');

  // Initializing GoogleGenAI only once when needed
  const getGenAI = useCallback(() => {
    return new GoogleGenAI({ apiKey: process.env.API_KEY });
  }, []);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prevMessages) => {
      // If it's a partial message, find and update it
      if (message.isPartial && message.id) {
        const existingMessageIndex = prevMessages.findIndex(
          (msg) => msg.id === message.id && msg.speaker === message.speaker
        );
        if (existingMessageIndex !== -1) {
          const updatedMessages = [...prevMessages];
          updatedMessages[existingMessageIndex] = message;
          return updatedMessages;
        }
      }
      // Otherwise, add a new message
      return [...prevMessages, message];
    });
  }, []);

  const clearPartialMessages = useCallback(() => {
    setMessages((prevMessages) =>
      prevMessages.filter((msg) => !msg.isPartial)
    );
  }, []);

  const handleMessage = useCallback(async (message: LiveServerMessage) => {
    // Handle input transcription
    if (message.serverContent?.inputTranscription) {
      const text = message.serverContent.inputTranscription.text;
      if (text) {
        if (!lastUserMessageIdRef.current) {
          lastUserMessageIdRef.current = `user-${Date.now()}`;
          addMessage({ id: lastUserMessageIdRef.current, speaker: Speaker.USER, text: text, isPartial: true });
        } else {
          addMessage({ id: lastUserMessageIdRef.current, speaker: Speaker.USER, text: text, isPartial: true });
        }
      }
      currentInputTranscriptionRef.current = text;
      setStatusMessage('Listening...');
    }

    // Handle model output transcription
    if (message.serverContent?.outputTranscription) {
      const text = message.serverContent.outputTranscription.text;
      if (text) {
        if (!lastModelMessageIdRef.current) {
          lastModelMessageIdRef.current = `model-${Date.now()}`;
          addMessage({ id: lastModelMessageIdRef.current, speaker: Speaker.MODEL, text: text, isPartial: true });
        } else {
          addMessage({ id: lastModelMessageIdRef.current, speaker: Speaker.MODEL, text: text, isPartial: true });
        }
      }
      currentOutputTranscriptionRef.current = text;
      setStatusMessage('Speaking...');
    }

    // Process model audio output
    const base64EncodedAudioString = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
    if (base64EncodedAudioString && outputAudioContextRef.current) {
      nextStartTimeRef.current = Math.max(
        nextStartTimeRef.current,
        outputAudioContextRef.current.currentTime,
      );

      const audioBuffer = await decodeAudioData(
        decode(base64EncodedAudioString),
        outputAudioContextRef.current,
        24000, // Sample rate of model output audio
        1,     // Number of channels
      );

      const source = outputAudioContextRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputAudioContextRef.current.destination); // Connect to default speakers
      source.addEventListener('ended', () => {
        outputAudioSourcesRef.current.delete(source);
        if (outputAudioSourcesRef.current.size === 0 && !isRecording && !showPastTranscripts) { // If no more audio to play and not recording
            setStatusMessage('Press the mic to continue.');
        }
      });
      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += audioBuffer.duration;
      outputAudioSourcesRef.current.add(source);
      setStatusMessage('Speaking...'); // Explicitly set status during playback
    }

    // When a turn is complete, finalize messages
    if (message.serverContent?.turnComplete) {
      if (currentInputTranscriptionRef.current) {
        addMessage({ id: lastUserMessageIdRef.current, speaker: Speaker.USER, text: currentInputTranscriptionRef.current, isPartial: false });
        currentInputTranscriptionRef.current = '';
        lastUserMessageIdRef.current = '';
      }
      if (currentOutputTranscriptionRef.current) {
        addMessage({ id: lastModelMessageIdRef.current, speaker: Speaker.MODEL, text: currentOutputTranscriptionRef.current, isPartial: false });
        currentOutputTranscriptionRef.current = '';
        lastModelMessageIdRef.current = '';
      }
      if (!isRecording && outputAudioSourcesRef.current.size === 0) {
        setStatusMessage('Press the mic to continue.');
      } else if (isRecording) {
        setStatusMessage('Listening...'); // After model speaks, it's back to listening
      }
    }

    const interrupted = message.serverContent?.interrupted;
    if (interrupted) {
      for (const source of outputAudioSourcesRef.current.values()) {
        source.stop();
        outputAudioSourcesRef.current.delete(source);
      }
      nextStartTimeRef.current = 0;
      clearPartialMessages();
      setStatusMessage('Conversation interrupted. Please speak again.');
    }
  }, [addMessage, clearPartialMessages, isRecording, showPastTranscripts]);

  const handleError = useCallback((e: ErrorEvent) => {
    console.error('Live session error:', e);
    setStatusMessage(`Error: ${e.message}. Please try again.`);
    stopInterview(); // Attempt to stop on error
  }, []);

  const handleClose = useCallback((e: CloseEvent) => {
    console.debug('Live session closed:', e);
    // Only update status if not intentionally stopping
    if (isRecording) { // If recording was true, it means it was an unexpected close or error
      setStatusMessage('Interview ended due to connection loss. Please restart.');
      stopInterview();
    }
  }, [isRecording]);

  const saveCurrentTranscript = useCallback(() => {
    if (messages.length > 0) {
      const newTranscript: SavedTranscriptSession = {
        id: `transcript-${Date.now()}`,
        timestamp: Date.now(),
        messages: messages.filter(msg => !msg.isPartial), // Only save non-partial messages
      };
      setSavedTranscripts((prev) => {
        const updated = [...prev, newTranscript];
        localStorage.setItem('interviewTranscripts', JSON.stringify(updated));
        return updated;
      });
      setStatusMessage('Interview ended and transcript saved!');
    } else {
      setStatusMessage('Interview ended.');
    }
  }, [messages]);

  const stopInterview = useCallback(() => {
    setIsRecording(false);
    setIsLoading(false);
    saveCurrentTranscript(); // Save before clearing messages
    setMessages([]); // Then clear messages for next session

    // Stop microphone stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Disconnect audio nodes
    if (scriptProcessorRef.current && inputAudioContextRef.current) {
      scriptProcessorRef.current.disconnect();
      inputAudioContextRef.current.close().catch(e => console.error("Error closing input audio context:", e));
      inputAudioContextRef.current = null;
      scriptProcessorRef.current = null;
    }

    // Stop all playing model audio
    outputAudioSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        console.warn("Could not stop audio source, it might have already ended.", e);
      }
    });
    outputAudioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close().catch(e => console.error("Error closing output audio context:", e));
      outputAudioContextRef.current = null;
    }

    // Close Live API session
    if (liveSessionRef.current) {
      liveSessionRef.current.then((session) => {
        session.close();
      }).catch(e => console.error("Error closing live session:", e));
      liveSessionRef.current = null;
    }

    clearPartialMessages();
    currentInputTranscriptionRef.current = '';
    currentOutputTranscriptionRef.current = '';
    lastUserMessageIdRef.current = '';
    lastModelMessageIdRef.current = '';
  }, [clearPartialMessages, saveCurrentTranscript]);

  const startInterview = async () => {
    setIsLoading(true);
    setStatusMessage('Connecting to AI interviewer...');
    setMessages([]);
    clearPartialMessages();
    lastUserMessageIdRef.current = '';
    lastModelMessageIdRef.current = '';
    setShowPastTranscripts(false); // Hide past transcripts view
    setSelectedPastTranscript(null); // Clear selected past transcript

    try {
      if (!(await navigator.mediaDevices.getUserMedia({ audio: true }))) {
        throw new Error('Microphone access denied or not available.');
      }
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      inputAudioContextRef.current = new window.AudioContext({ sampleRate: 16000 });
      outputAudioContextRef.current = new window.AudioContext({ sampleRate: 24000 });

      const ai = getGenAI();
      liveSessionRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.debug('Live session opened.');
            setIsRecording(true);
            setIsLoading(false);
            // Initial prompt from system instruction is handled by the model.
            // We set a temporary status here, the first model message will update it.
            setStatusMessage('Interview started. Waiting for AI to speak...');
          },
          onmessage: handleMessage,
          onerror: handleError,
          onclose: handleClose,
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }, // Use selected voice here
          },
          systemInstruction: `You are an AI interviewer conducting a pre-screening for a potential hire.
          Start the conversation with: "Welcome! Can you please tell me a bit about your experience and what you're looking for in a role?"
          Ask basic questions to assess their qualifications. Keep your questions concise and allow the candidate to speak without interruption.
          Focus on general work experience, skills, and career aspirations. Do not ask personal questions or for specific company names or sensitive information.
          Your goal is to quickly gauge their communication skills and basic fit for a general professional role.`,
        },
      });

      // Stream audio from the microphone to the model.
      const source = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
      scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
        const pcmBlob = createBlob(inputData);
        // CRITICAL: Solely rely on sessionPromise resolves and then call `session.sendRealtimeInput`, do not add other condition checks.
        liveSessionRef.current?.then((session) => {
          session.sendRealtimeInput({ media: pcmBlob });
        });
      };
      source.connect(scriptProcessorRef.current);
      scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);

    } catch (error: unknown) {
      console.error('Failed to start interview:', error);
      setIsLoading(false);
      setIsRecording(false);
      if (error instanceof Error) {
        setStatusMessage(`Failed to start: ${error.message}`);
      } else {
        setStatusMessage('Failed to start the interview due to an unknown error.');
      }
      stopInterview();
    }
  };

  useEffect(() => {
    const storedTranscripts = localStorage.getItem('interviewTranscripts');
    if (storedTranscripts) {
      setSavedTranscripts(JSON.parse(storedTranscripts));
    }

    return () => {
      stopInterview();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleInterview = () => {
    if (isRecording || isLoading) {
      stopInterview();
    } else {
      startInterview();
    }
  };

  const handleVoiceChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedVoice(event.target.value);
  };

  const deleteTranscript = (id: string) => {
    setSavedTranscripts((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      localStorage.setItem('interviewTranscripts', JSON.stringify(updated));
      return updated;
    });
    if (selectedPastTranscript?.id === id) {
      setSelectedPastTranscript(null); // Clear if the deleted transcript was being viewed
    }
  };

  const clearAllTranscripts = () => {
    if (window.confirm("Are you sure you want to delete all past conversation transcripts?")) {
      localStorage.removeItem('interviewTranscripts');
      setSavedTranscripts([]);
      setSelectedPastTranscript(null);
      setStatusMessage('All past transcripts cleared.');
    }
  };

  const LiveInterviewView = (
    <>
      <div className="mb-4 flex justify-center items-center gap-2">
        <label htmlFor="voice-select" className="text-gray-700 font-medium">Interviewer Voice:</label>
        <select
          id="voice-select"
          value={selectedVoice}
          onChange={handleVoiceChange}
          className="p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          aria-label="Select interviewer voice"
          disabled={isRecording || isLoading}
        >
          {availableVoices.map((voice) => (
            <option key={voice.name} value={voice.name}>
              {voice.displayName}
            </option>
          ))}
        </select>
      </div>
      <TranscriptDisplay messages={messages} />
      <div className="mt-6 flex items-center justify-center space-x-4">
        <div className="text-lg font-medium text-gray-700">
          Status: <span className="text-blue-600">{statusMessage}</span>
        </div>
        <MicButton
          isRecording={isRecording}
          isLoading={isLoading}
          onClick={toggleInterview}
        />
      </div>
    </>
  );

  const PastTranscriptsListView = (
    <div className="flex flex-col h-full">
      <h2 className="text-2xl font-bold text-gray-800 mb-4 text-center">Past Conversations</h2>
      <div className="flex justify-between items-center mb-4">
        <button
          onClick={() => setShowPastTranscripts(false)}
          className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-300"
        >
          &larr; Back to Live Interview
        </button>
        <button
          onClick={clearAllTranscripts}
          disabled={savedTranscripts.length === 0}
          className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Clear All Transcripts
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 bg-gray-50 rounded-md border border-gray-200">
        {savedTranscripts.length === 0 ? (
          <p className="text-gray-500 text-center italic">No past conversations found.</p>
        ) : (
          <ul className="space-y-2">
            {[...savedTranscripts].sort((a, b) => b.timestamp - a.timestamp).map((transcript) => (
              <li key={transcript.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-white border border-gray-200 rounded-lg shadow-sm">
                <span className="font-medium text-gray-800 mb-2 sm:mb-0">
                  {new Date(transcript.timestamp).toLocaleString()}
                </span>
                <div className="flex space-x-2">
                  <button
                    onClick={() => setSelectedPastTranscript(transcript)}
                    className="bg-indigo-500 hover:bg-indigo-600 text-white text-sm py-1 px-3 rounded focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  >
                    View
                  </button>
                  <button
                    onClick={() => deleteTranscript(transcript.id)}
                    className="bg-red-400 hover:bg-red-500 text-white text-sm py-1 px-3 rounded focus:outline-none focus:ring-2 focus:ring-red-200"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const SelectedPastTranscriptView = (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center mb-4">
        <button
          onClick={() => setSelectedPastTranscript(null)}
          className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-300"
        >
          &larr; Back to List
        </button>
        <h2 className="text-2xl font-bold text-gray-800 text-center flex-grow">
          Conversation from {selectedPastTranscript?.timestamp ? new Date(selectedPastTranscript.timestamp).toLocaleString() : 'N/A'}
        </h2>
      </div>
      <TranscriptDisplay messages={selectedPastTranscript?.messages || []} />
    </div>
  );

  return (
    <div className="flex flex-col h-[90vh] bg-white rounded-lg shadow-xl p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-4 text-center">AI Interviewer</h1>
      <p className="text-gray-600 text-center mb-4">
        This AI will ask you basic interview questions to help pre-screen your qualifications.
      </p>

      <div className="flex-grow overflow-hidden flex flex-col">
        {showPastTranscripts ? (
          selectedPastTranscript ? SelectedPastTranscriptView : PastTranscriptsListView
        ) : (
          LiveInterviewView
        )}
      </div>

      {!isRecording && !isLoading && !showPastTranscripts && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => setShowPastTranscripts(true)}
            className="bg-gray-700 hover:bg-gray-800 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-gray-500"
          >
            View Past Conversations
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
