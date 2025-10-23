
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality } from '@google/genai';
import { ChatMessage, Speaker } from './types';
import { decode, decodeAudioData, encode, createBlob } from './utils/audioUtils';
import MicButton from './components/MicButton';
import TranscriptDisplay from './components/TranscriptDisplay';

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('Press the mic to start the interview.');

  const liveSessionRef = useRef<Promise<LiveSession> | null>(null);
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
        if (outputAudioSourcesRef.current.size === 0 && !isRecording) { // If no more audio to play and not recording
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
      setStatusMessage('Listening...'); // After model speaks, it's back to listening
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
  }, [addMessage, clearPartialMessages, isRecording]);

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

  const startInterview = async () => {
    setIsLoading(true);
    setStatusMessage('Connecting to AI interviewer...');
    setMessages([]);
    clearPartialMessages();
    lastUserMessageIdRef.current = '';
    lastModelMessageIdRef.current = '';

    try {
      if (!(await navigator.mediaDevices.getUserMedia({ audio: true }))) {
        throw new Error('Microphone access denied or not available.');
      }
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Fix: Use window.AudioContext directly for modern browser compatibility.
      inputAudioContextRef.current = new window.AudioContext({ sampleRate: 16000 });
      // Fix: Use window.AudioContext directly for modern browser compatibility.
      outputAudioContextRef.current = new window.AudioContext({ sampleRate: 24000 });

      const ai = getGenAI();
      liveSessionRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.debug('Live session opened.');
            setIsRecording(true);
            setIsLoading(false);
            setStatusMessage('Welcome! Can you please tell me a bit about your experience and what you\'re looking for in a role?'); // Initial prompt from system instruction
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
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
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

  const stopInterview = useCallback(() => {
    setIsRecording(false);
    setIsLoading(false);
    setStatusMessage('Interview ended. Press the mic to start a new one.');

    // Stop microphone stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Disconnect audio nodes
    if (scriptProcessorRef.current && inputAudioContextRef.current) {
      scriptProcessorRef.current.disconnect();
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [clearPartialMessages]);

  useEffect(() => {
    // Cleanup function when component unmounts
    return () => {
      stopInterview();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  const toggleInterview = () => {
    if (isRecording || isLoading) {
      stopInterview();
    } else {
      startInterview();
    }
  };

  return (
    <div className="flex flex-col h-[80vh] bg-white rounded-lg shadow-xl p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-4 text-center">AI Interviewer</h1>
      <p className="text-gray-600 text-center mb-6">
        This AI will ask you basic interview questions to help pre-screen your qualifications.
      </p>

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
    </div>
  );
};

export default App;
