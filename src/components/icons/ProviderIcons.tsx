import React from 'react';

import openaiLogo from '../../assets/providers/openai.svg';
import anthropicLogo from '../../assets/providers/anthropic.svg';
import geminiLogo from '../../assets/providers/gemini.svg';
import deepseekLogo from '../../assets/providers/deepseek.svg';
import aliyunLogo from '../../assets/providers/aliyun.svg';
import zhipuLogo from '../../assets/providers/zhipu.svg';
import moonshotLogo from '../../assets/providers/moonshot.svg';
import volcengineLogo from '../../assets/providers/volcengine.svg';
import siliconflowLogo from '../../assets/providers/siliconflow.svg';
import openrouterLogo from '../../assets/providers/openrouter.svg';
import groqLogo from '../../assets/providers/groq.svg';
import aliyunAsrLogo from '../../assets/providers/aliyun-asr.svg';
import volcengineAsrLogo from '../../assets/providers/volcengine-asr.svg';
import iflytekAsrLogo from '../../assets/providers/iflytek-asr.svg';
import tencentAsrLogo from '../../assets/providers/tencent-asr.svg';
import deepgramLogo from '../../assets/providers/deepgram.svg';
import assemblyaiLogo from '../../assets/providers/assemblyai.svg';
import elevenlabsLogo from '../../assets/providers/elevenlabs.svg';

interface IconProps {
  className?: string;
}

/**
 * 应用主品牌图标（办公蓝几何矢量标志）
 */
export const BrandLogoIcon: React.FC<IconProps> = ({ className = 'w-6 h-6' }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#1456F0" />
    <path
      d="M7.5 12.2V11.8C7.5 9.31472 9.51472 7.3 12 7.3C14.4853 7.3 16.5 9.31472 16.5 11.8V12.2"
      stroke="white"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    <path
      d="M9.5 13.5V16.2M12 11.2V17M14.5 13.5V16.2"
      stroke="white"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
  </svg>
);

const PROVIDER_LOGO_MAP: Record<string, string> = {
  openai: openaiLogo,
  'openai-audio': openaiLogo,
  anthropic: anthropicLogo,
  gemini: geminiLogo,
  deepseek: deepseekLogo,
  aliyun: aliyunLogo,
  zhipu: zhipuLogo,
  moonshot: moonshotLogo,
  volcengine: volcengineLogo,
  siliconflow: siliconflowLogo,
  openrouter: openrouterLogo,
  groq: groqLogo,
  'aliyun-asr': aliyunAsrLogo,
  'volcengine-asr': volcengineAsrLogo,
  'iflytek-asr': iflytekAsrLogo,
  'tencent-asr': tencentAsrLogo,
  deepgram: deepgramLogo,
  assemblyai: assemblyaiLogo,
  elevenlabs: elevenlabsLogo,
};

/**
 * 真实品牌官方矢量图标组件（包含全部主流大模型供应商与语音转写供应商）
 */
export const ProviderIcon: React.FC<{ providerId: string; className?: string }> = ({
  providerId,
  className = 'w-7 h-7',
}) => {
  const logoSrc = PROVIDER_LOGO_MAP[providerId];

  if (providerId === 'builtin-free-asr') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#EBF2FF" stroke="#3370FF" strokeWidth="1.5" />
        <path
          d="M7.5 11V13M10.5 8.5V15.5M13.5 7V17M16.5 10V14"
          stroke="#1456F0"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={`${className} object-contain select-none shrink-0`}
      />
    );
  }

  // 自定义接口图标
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="4.5"
        stroke="#4E5969"
        strokeWidth="1.8"
        strokeDasharray="3 2.5"
      />
      <path
        d="M9.5 9.5L7 12L9.5 14.5M14.5 9.5L17 12L14.5 14.5"
        stroke="#1456F0"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
