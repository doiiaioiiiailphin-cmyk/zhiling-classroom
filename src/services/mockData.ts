import {
  ASR_PROVIDER_PRESETS,
  LLM_PROVIDER_PRESETS,
  OPENCODE_FREE_PROVIDER_ID,
} from '../constants/providers';
import type {
  Aec3AddonStatus,
  Aec3DownloadProgress,
  AppSettings,
  AsrProviderConfig,
  AudioImportProgress,
  ChatMessage,
  ClassSessionCard,
  FlashcardItem,
  FolderItem,
  KnowledgeSegment,
  LLMProviderConfig,
  NativeAudioDevices,
  SearchHitItem,
  SegmentDetailedExplanation,
  SessionAttachmentItem,
  SessionExportRequest,
  SessionStudyNote,
  SessionWorkspacePayload,
  SpeakerProfile,
  UtteranceItem,
  UtterancePatch,
} from '../types/domain';

const STORAGE_KEY = 'zhiling_class_demo_state_v1';

interface MockDatabase {
  folders: FolderItem[];
  sessions: ClassSessionCard[];
  workspaces: Record<
    string,
    {
      speakers: SpeakerProfile[];
      segments: KnowledgeSegment[];
      messages: ChatMessage[];
      studyNote?: SessionStudyNote;
      flashcards?: FlashcardItem[];
      attachments?: SessionAttachmentItem[];
    }
  >;
  settings: AppSettings;
}

function buildDefaultSettings(): AppSettings {
  const llmProviders: Record<string, LLMProviderConfig> = {};
  for (const preset of LLM_PROVIDER_PRESETS) {
    const isPreconfigured =
      preset.id === 'openai' || preset.id === 'anthropic' || preset.id === 'gemini';
    llmProviders[preset.id] = {
      providerId: preset.id,
      name: preset.name,
      isCustom: preset.isCustom,
      protocol: preset.protocol,
      baseUrl: preset.defaultBaseUrl,
      apiKey: isPreconfigured ? 'sk-demo-configured-key' : '',
      availableModels: isPreconfigured ? [...preset.defaultSampleModels] : [],
      lastFetchedAt: isPreconfigured ? '2026-11-15T09:00:00Z' : undefined,
    };
  }

  const asrProviders: Record<string, AsrProviderConfig> = {};
  for (const preset of ASR_PROVIDER_PRESETS) {
    const isDefault = preset.id === 'aliyun-asr' || preset.id === 'openai-audio';
    asrProviders[preset.id] = {
      providerId: preset.id,
      name: preset.name,
      isCustom: preset.isCustom,
      protocol: preset.protocol,
      baseUrl: preset.defaultBaseUrl,
      apiKey: isDefault ? 'asr-demo-configured-key' : '',
      appId: preset.requiresAppId ? 'demo-app-id' : undefined,
      availableModels: [...preset.defaultModels],
      selectedModelId: preset.defaultModels[0] ?? '',
    };
  }

  return {
    selectedLlmProviderId: 'openai',
    llmProviders,
    featureRouting: {
      chat: {
        enabled: true,
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
      },
      sentenceCorrection: {
        enabled: true,
        providerId: 'gemini',
        modelId: 'gemini-2.5-flash',
      },
      resegmentation: {
        enabled: true,
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
      },
      keyTermHighlight: {
        enabled: true,
        providerId: 'gemini',
        modelId: 'gemini-2.5-flash',
      },
      bubbleExplanation: {
        enabled: true,
        providerId: 'openai',
        modelId: 'gpt-4.1',
      },
    },
    selectedAsrProviderId: 'builtin-free-asr',
    asrProviders,
    enableSpeakerDiarization: true,
    expectedSpeakerMode: 'auto',
    recognitionLanguage: 'zh-en',
    audioInputSource: 'mixed',
    audioDeviceId: 'default',
    systemAudioDeviceId: 'default',
    micEnabled: true,
    systemAudioEnabled: true,
    enableWebrtcAec3: false,
    aec3PromptDismissed: false,
    enableDualChannelSpeakerSplit: true,
    globalHotwords: [],
    desktopHotkeys: {
      enabled: true,
      toggleRecording: 'Alt+Shift+R',
      toggleMicMute: 'Alt+Shift+M',
      captureScreenshot: 'Alt+Shift+S',
      bookmarkConfused: 'Alt+Shift+B',
      toggleMiniOverlay: 'Alt+Shift+O',
    },
    enableVadAutoPause: true,
    autoSaveSession: true,
    defaultExportFormat: 'markdown',
  };
}

function createInitialMockDb(): MockDatabase {
  const folders: FolderItem[] = [
    {
      id: 'folder-cs-core',
      name: '计算机专业核心课',
      parentId: null,
      createdAt: '2026-11-10T08:30:00Z',
      updatedAt: '2026-11-14T16:20:00Z',
    },
  ];

  const sessions: ClassSessionCard[] = [
    {
      id: 'session-dl-attention',
      folderId: null,
      title: '深度学习导论：Transformer 与注意力机制',
      status: 'paused',
      durationSeconds: 2685,
      speakerCount: 2,
      segmentCount: 3,
      createdAt: '2026-11-14T14:00:00Z',
      updatedAt: '2026-11-14T14:45:00Z',
    },
    {
      id: 'session-macro-policy',
      folderId: null,
      title: '宏观经济学：货币政策传导与利率走廊',
      status: 'paused',
      durationSeconds: 3120,
      speakerCount: 2,
      segmentCount: 2,
      createdAt: '2026-11-12T09:30:00Z',
      updatedAt: '2026-11-12T10:22:00Z',
    },
    {
      id: 'session-os-vm',
      folderId: 'folder-cs-core',
      title: '操作系统：虚拟内存、页表与缺页中断',
      status: 'paused',
      durationSeconds: 2940,
      speakerCount: 2,
      segmentCount: 2,
      createdAt: '2026-11-11T10:00:00Z',
      updatedAt: '2026-11-11T10:49:00Z',
    },
  ];

  const workspaces: MockDatabase['workspaces'] = {
    'session-dl-attention': {
      speakers: [
        { id: 'spk-1', label: '周教授（主讲）' },
        { id: 'spk-2', label: '林同学（提问）' },
      ],
      segments: [
        {
          id: 'seg-1',
          sessionId: 'session-dl-attention',
          orderIndex: 1,
          topicTitle: '循环神经网络的长距离依赖瓶颈',
          utterances: [
            {
              id: 'utt-101',
              speakerId: 'spk-1',
              speakerLabel: '周教授（主讲）',
              timestampText: '02:15',
              startTimeMs: 135000,
              endTimeMs: 162000,
              rawText:
                '我们先回顾一下传统循环神经网络在长序列建模上的缺陷，由于隐藏状态必须按时间步串行传递，很容易在反向传播中出现梯度消失或者信息被稀释的问题。',
              refinedText:
                '我们先回顾传统循环神经网络（RNN）在长序列建模上的核心瓶颈：由于隐藏状态必须按时间步串行传递，不仅难以利用现代 GPU 并行计算，还极易在反向传播过程中引发梯度消失与远端语义稀释。',
              isRefined: true,
            },
          ],
          highlights: [
            {
              id: 'hl-101',
              term: '隐藏状态',
              explanation:
                '序列模型在每一时间步维护的内部向量表示，用于汇总当前时间步之前的历史上下文信息。',
            },
            {
              id: 'hl-102',
              term: '梯度消失',
              explanation:
                '深层或长序列网络反向传播时梯度呈指数级衰减趋近于零，导致早期时间步参数几乎无法更新的现象。',
            },
          ],
          detailedExplanation: {
            title: '序列模型的串行瓶颈与长程依赖问题',
            corePoints: [
              '计算耦合：第 t 步的计算严格依赖第 t-1 步输出，训练阶段无法跨时间步并行。',
              '信息压缩损耗：固定维度的隐藏向量难以无损承载超长文本的全部细节。',
              '演进动机：直接催生了完全基于自注意力机制、任意两位置路径长度为 O(1) 的 Transformer 架构。',
            ],
            elaboration:
              '本段对比了串行递推结构与全局注意力结构的本质差异。理解这一瓶颈是掌握后续自注意力机制为什么采用矩阵并行内积计算的逻辑起点。',
          },
        },
        {
          id: 'seg-2',
          sessionId: 'session-dl-attention',
          orderIndex: 2,
          topicTitle: '缩放点积注意力与缩放因子推导',
          utterances: [
            {
              id: 'utt-102',
              speakerId: 'spk-1',
              speakerLabel: '周教授（主讲）',
              timestampText: '08:40',
              startTimeMs: 520000,
              endTimeMs: 558000,
              rawText:
                '在缩放点机注意力里面，每个词向量分别投影成查询向量、键向量和值向量，算完内积之后一定要除以根号 dk，然后再送进 Softmax 归一化。',
              refinedText:
                '在缩放点积注意力中，输入词向量经线性映射分别生成查询向量（Query）、键向量（Key）和值向量（Value）；计算 Q 与 K 的点积后必须除以根号 d_k 进行缩放，随后再送入 Softmax 完成权重归一化。',
              isRefined: true,
            },
            {
              id: 'utt-103',
              speakerId: 'spk-2',
              speakerLabel: '林同学（提问）',
              timestampText: '09:32',
              startTimeMs: 572000,
              endTimeMs: 590000,
              rawText:
                '老师，如果维度 dk 比较小的时候不除以根号 dk，会对训练收敛产生很大影响吗？',
              refinedText:
                '老师，当特征维度 d_k 较小时如果不除以根号 d_k，是否也会显著影响模型收敛？',
              isRefined: true,
            },
            {
              id: 'utt-104',
              speakerId: 'spk-1',
              speakerLabel: '周教授（主讲）',
              timestampText: '09:50',
              startTimeMs: 590000,
              endTimeMs: 625000,
              rawText:
                '维度小的时候点积方差不大影响不明显，但当 dk 达到 64 或 128 时，点积结果的方差就是 dk，不缩放会让 Softmax 进入饱和区，梯度几乎变成零。',
              refinedText:
                '当 d_k 较小时点积方差尚在温和区间，影响有限；但当 d_k 增大至 64 或 128 时，点积结果的方差随 d_k 线性增长，若不缩放会使 Softmax 推入极值饱和区，导致梯度趋近于零。',
              isRefined: true,
            },
          ],
          highlights: [
            {
              id: 'hl-201',
              term: '缩放点积注意力',
              explanation:
                'Transformer 的核心相关性度量算子，通过 Q 与 K 的转置相乘除以 √d_k 再经 Softmax 加权求和 V。',
            },
            {
              id: 'hl-202',
              term: 'Softmax',
              explanation:
                '将任意实数打分向量映射为总和为 1 的概率分布函数；输入绝对值过大时导数会趋于 0。',
            },
            {
              id: 'hl-203',
              term: '饱和区',
              explanation:
                '激活或归一化函数输出趋近边界常数（如 0 或 1）、局部斜率极小而难以回传有效梯度的区域。',
            },
          ],
          detailedExplanation: {
            title: '缩放因子 √d_k 的统计学原理',
            corePoints: [
              '方差推导：假设 Q、K 各分量独立同分布且均值为 0、方差为 1，则点积结果的均值为 0、方差为 d_k。',
              '数值稳定：除以 √d_k 可将点积结果的标准差重新拉回 1，避免单个大值垄断注意力分布。',
              '师生问答结论：d_k 越大，该缩放项对维持反向传播梯度健康越关键。',
            ],
            elaboration:
              '本段融合了周教授的公式讲解与林同学的课堂追问，完整阐明了注意力打分为什么要从普通点积演进为“缩放点积”。这也是期末笔试与算法面试的高频考点。',
          },
        },
        {
          id: 'seg-3',
          sessionId: 'session-dl-attention',
          orderIndex: 3,
          topicTitle: '多头注意力与子空间特征融合',
          utterances: [
            {
              id: 'utt-105',
              speakerId: 'spk-1',
              speakerLabel: '周教授（主讲）',
              timestampText: '16:10',
              startTimeMs: 970000,
              endTimeMs: 1015000,
              rawText:
                '单头注意力往往只能聚焦一种相关性，因此我们引入多头注意力，把高维空间拆分成多个独立的表示子空间并行计算，最后拼接并通过输出投影矩阵融合。',
              refinedText:
                '单头注意力往往只能聚焦单一维度的关联模式，因此 Transformer 引入多头注意力机制，将高维通道切分为多个独立的表示子空间并行捕获语法、指代与语义关联，最后拼接并通过输出投影矩阵融合。',
              isRefined: true,
            },
          ],
          highlights: [
            {
              id: 'hl-301',
              term: '多头注意力',
              explanation:
                '使用多组独立投影矩阵并行执行注意力计算，使模型能同时关注不同位置、不同语义层面的上下文特征。',
            },
            {
              id: 'hl-302',
              term: '表示子空间',
              explanation:
                '由不同线性变换矩阵映射出的低维特征空间，每个注意力头在各自子空间内专注特定关系模式。',
            },
          ],
          detailedExplanation: {
            title: '多头注意力（Multi-Head Attention）机制拆解',
            corePoints: [
              '总计算量等价：若设头数为 h，每头维度设为 d_model / h，整体浮点运算量与全维单头相当。',
              '多视角解耦：不同头可分别学习局部邻近依赖、长程指代消解或句法修饰关系。',
              '末端线性融合：Concat 拼接后乘以 W_O 矩阵实现跨头特征交互。',
            ],
            elaboration:
              '多头设计相当于在注意力层内部构建了并行的多通道特征提取器，避免了单一 Softmax 权重平均化导致的语义相互掩盖。',
          },
        },
      ],
      messages: [
        {
          id: 'msg-1',
          sessionId: 'session-dl-attention',
          role: 'user',
          content: '请帮我总结一下刚才老师讲的为什么要除以根号 d_k？',
          createdAt: '2026-11-14T14:12:00Z',
        },
        {
          id: 'msg-2',
          sessionId: 'session-dl-attention',
          role: 'assistant',
          referencedSegmentCount: 3,
          content:
            '结合本堂课第 2 段周教授的讲解与问答，除以 √d_k 的核心原因如下：\n1. 控制点积方差：当 Q 和 K 分量均值为 0、方差为 1 时，二者点积的方差会放大为 d_k。\n2. 防止 Softmax 饱和：当维度 d_k 较大（如 64 或 128）时，未缩放的点积数值差距极大，会使 Softmax 输出趋近于 0 或 1 的极值饱和区。\n3. 保障梯度回传：除以 √d_k 能将方差重新标准化为 1，让梯度保持在平滑有效区间，确保训练稳定收敛。',
          createdAt: '2026-11-14T14:12:03Z',
        },
      ],
    },
    'session-macro-policy': {
      speakers: [{ id: 'spk-econ-1', label: '陆老师（主讲）' }],
      segments: [
        {
          id: 'seg-econ-1',
          sessionId: 'session-macro-policy',
          orderIndex: 1,
          topicTitle: '公开市场操作与利率走廊机制',
          utterances: [
            {
              id: 'utt-econ-1',
              speakerId: 'spk-econ-1',
              speakerLabel: '陆老师（主讲）',
              timestampText: '05:20',
              startTimeMs: 320000,
              endTimeMs: 360000,
              rawText:
                '现代央行越来越依靠利率走廊来引导短期市场利率，上限通常是常备借贷便利利率，下限则是超额准备金利率。',
              refinedText:
                '现代中央银行主要依托利率走廊调控短期货币市场利率：走廊上限通常由常备借贷便利（SLF）利率构成，走廊下限则由超额存款准备金利率锚定。',
              isRefined: true,
            },
          ],
          highlights: [
            {
              id: 'hl-econ-1',
              term: '利率走廊',
              explanation:
                '央行通过设定向商业银行提供流动性便利的贷款利率上限与存款利率下限，将市场拆借利率约束在目标区间的调控框架。',
            },
            {
              id: 'hl-econ-2',
              term: '常备借贷便利',
              explanation:
                '央行满足金融机构临时性大额流动性需求的合格抵押品贷款工具，承担利率走廊上限职能。',
            },
          ],
          detailedExplanation: {
            title: '价格型货币政策调控：利率走廊原理',
            corePoints: [
              '上限约束：商业银行不会以高于央行 SLF 的利率在同业市场融入资金。',
              '下限支撑：商业银行不会以低于央行超额准备金收益的利率对外拆出资金。',
            ],
            elaboration:
              '相比传统数量型调控，利率走廊能够有效降低短期市场利率波动率，稳定金融机构流动性预期。',
          },
        },
      ],
      messages: [],
    },
    'session-os-vm': {
      speakers: [{ id: 'spk-os-1', label: '赵教授（主讲）' }],
      segments: [
        {
          id: 'seg-os-1',
          sessionId: 'session-os-vm',
          orderIndex: 1,
          topicTitle: '多级页表与快表 TLB 加速机制',
          utterances: [
            {
              id: 'utt-os-1',
              speakerId: 'spk-os-1',
              speakerLabel: '赵教授（主讲）',
              timestampText: '11:05',
              startTimeMs: 665000,
              endTimeMs: 710000,
              rawText:
                '多级页表虽然节省了连续物理内存空间，但增加了访存次数，所以硬件上必须配合旁路转换缓冲也就是快表来缓存热点页表项。',
              refinedText:
                '多级页表虽然通过按需分配显著节省了页表占用的物理内存空间，但代价是拉长了地址转换的访存链路，因此硬件层必须配合快表（TLB）缓存高频访问的虚拟页号映射。',
              isRefined: true,
            },
          ],
          highlights: [
            {
              id: 'hl-os-1',
              term: '多级页表',
              explanation:
                '将超大线性页表拆分为树状层级结构，未使用的虚拟地址区间无需分配二级及下级页表内存。',
            },
            {
              id: 'hl-os-2',
              term: '快表（TLB）',
              explanation:
                '位于 MMU 内部的高速相联存储器，直接缓存近期使用过的虚拟页号到物理页框号的映射以规避多次内存查表。',
            },
          ],
          detailedExplanation: {
            title: '空间与时间的折中：多级页表 + TLB',
            corePoints: [
              '多级页表解决的是“每个进程页表占用过多连续内存”的空间开销问题。',
              'TLB 利用程序局部性原理，在命中时将地址转换耗时压缩至接近零额外访存。',
            ],
            elaboration:
              '考试常考有效访问时间（EAT）计算：需结合 TLB 命中率、TLB 查询耗时与内存页表级数联合求解。',
          },
        },
      ],
      messages: [],
    },
  };

  return {
    folders,
    sessions,
    workspaces,
    settings: buildDefaultSettings(),
  };
}

function loadDb(): MockDatabase {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as MockDatabase;
    }
  } catch {
    // 忽略解析异常，回退初始化数据
  }
  const initial = createInitialMockDb();
  saveDb(initial);
  return initial;
}

function saveDb(db: MockDatabase): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // 忽略本地存储配额异常
  }
}

export const mockAdapter = {
  async listFolders(): Promise<FolderItem[]> {
    const db = loadDb();
    return db.folders;
  },

  async createFolder(
    name: string,
    parentId: string | null = null,
    hotwords?: string[]
  ): Promise<FolderItem> {
    const db = loadDb();
    const now = new Date().toISOString();
    const folder: FolderItem = {
      id: `folder-${Date.now()}`,
      name: name.trim() || '新建文件夹',
      parentId,
      hotwords: hotwords?.length ? [...hotwords] : undefined,
      createdAt: now,
      updatedAt: now,
    };
    db.folders.unshift(folder);
    saveDb(db);
    return folder;
  },

  async updateFolder(
    id: string,
    patch: { name?: string; hotwords?: string[] }
  ): Promise<FolderItem> {
    const db = loadDb();
    const target = db.folders.find((f) => f.id === id);
    if (!target) throw new Error('文件夹不存在');
    if (patch.name !== undefined) {
      target.name = patch.name.trim() || target.name;
    }
    if (patch.hotwords !== undefined) {
      target.hotwords = patch.hotwords.filter((h) => h.trim()).map((h) => h.trim());
    }
    target.updatedAt = new Date().toISOString();
    saveDb(db);
    return target;
  },

  async deleteFolder(id: string): Promise<void> {
    const db = loadDb();
    db.folders = db.folders.filter((f) => f.id !== id);
    // 将文件夹内的课堂平滑移回根目录，避免误丢课堂笔记
    for (const s of db.sessions) {
      if (s.folderId === id) {
        s.folderId = null;
      }
    }
    saveDb(db);
  },

  async listSessions(): Promise<ClassSessionCard[]> {
    const db = loadDb();
    return db.sessions;
  },

  async createSession(folderId: string | null = null): Promise<SessionWorkspacePayload> {
    const db = loadDb();
    const now = new Date();
    const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日`;
    const id = `session-${Date.now()}`;
    const card: ClassSessionCard = {
      id,
      folderId,
      title: `新课堂记录（${dateLabel}）`,
      status: 'recording',
      durationSeconds: 0,
      speakerCount: 1,
      segmentCount: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const initialSegment: KnowledgeSegment = {
      id: `seg-${Date.now()}`,
      sessionId: id,
      orderIndex: 1,
      topicTitle: '课程导入与核心概念概述',
      utterances: [
        {
          id: `utt-${Date.now()}`,
          speakerId: 'spk-live-1',
          speakerLabel: '主讲人 1',
          timestampText: '00:08',
          startTimeMs: 8000,
          endTimeMs: 22000,
          rawText:
            '各位同学大家好，今天这堂课我们重点讨论分布式一致性协议中的主从复制与故障恢复机制。',
          refinedText:
            '各位同学大家好，今天本堂课我们重点探讨分布式一致性协议中的主从复制模型与自动故障恢复机制。',
          isRefined: true,
        },
      ],
      highlights: [
        {
          id: `hl-${Date.now()}-1`,
          term: '分布式一致性协议',
          explanation:
            '在多节点网络存在延迟或局部故障时，保证各副本节点对数据状态达成统一共识的通信规则（如 Raft、Paxos）。',
        },
        {
          id: `hl-${Date.now()}-2`,
          term: '主从复制',
          explanation:
            '由单一主节点接收写请求并将变更日志异步或半同步复制至从节点的数据高可用架构。',
        },
      ],
      detailedExplanation: {
        title: '分布式主从复制与容错导论',
        corePoints: [
          '读写职责划分：写操作统一经由 Leader 排序，从节点提供读扩展与热备容灾。',
          '核心权衡：同步复制保障强一致但抬高尾延迟，异步复制吞吐高但故障切换可能丢失尾部未同步日志。',
        ],
        elaboration:
          '本段为新开启课堂的首个实时聚合知识点示例。接入真实后端后，语音流转写结果将实时追加并自动触发重分段与重点词标注。',
      },
    };

    db.sessions.unshift(card);
    db.workspaces[id] = {
      speakers: [{ id: 'spk-live-1', label: '主讲人 1' }],
      segments: [initialSegment],
      messages: [],
    };
    saveDb(db);

    return {
      session: card,
      speakers: db.workspaces[id].speakers,
      segments: db.workspaces[id].segments,
      messages: db.workspaces[id].messages,
    };
  },

  async updateSession(
    id: string,
    patch: Partial<Pick<ClassSessionCard, 'title' | 'folderId' | 'status' | 'durationSeconds'>>
  ): Promise<ClassSessionCard> {
    const db = loadDb();
    const target = db.sessions.find((s) => s.id === id);
    if (!target) throw new Error('课堂不存在');
    if (patch.title !== undefined) target.title = patch.title.trim() || target.title;
    if (patch.folderId !== undefined) target.folderId = patch.folderId;
    if (patch.status !== undefined) target.status = patch.status;
    if (patch.durationSeconds !== undefined) target.durationSeconds = patch.durationSeconds;
    target.updatedAt = new Date().toISOString();
    saveDb(db);
    return target;
  },

  async deleteSession(id: string): Promise<void> {
    const db = loadDb();
    db.sessions = db.sessions.filter((s) => s.id !== id);
    delete db.workspaces[id];
    saveDb(db);
  },

  async getSessionWorkspace(id: string): Promise<SessionWorkspacePayload> {
    const db = loadDb();
    const session = db.sessions.find((s) => s.id === id);
    if (!session) throw new Error('未找到对应课堂');
    const ws = db.workspaces[id] ?? { speakers: [], segments: [], messages: [] };
    return {
      session,
      speakers: ws.speakers,
      segments: ws.segments,
      messages: ws.messages,
      studyNote: ws.studyNote,
      flashcards: ws.flashcards ?? [],
      attachments: ws.attachments ?? [],
      hasAudio: false,
      audioDurationMs: 0,
    };
  },

  async renameSpeaker(sessionId: string, speakerId: string, newLabel: string): Promise<void> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws) return;
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    for (const spk of ws.speakers) {
      if (spk.id === speakerId) spk.label = trimmed;
    }
    for (const seg of ws.segments) {
      for (const utt of seg.utterances) {
        if (utt.speakerId === speakerId) utt.speakerLabel = trimmed;
      }
    }
    saveDb(db);
  },

  async explainSegment(
    sessionId: string,
    segmentId: string
  ): Promise<SegmentDetailedExplanation> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    const seg = ws?.segments.find((item) => item.id === segmentId);
    if (!seg) throw new Error('未找到对应知识点段落');
    if (seg.detailedExplanation) {
      return seg.detailedExplanation;
    }
    const generated: SegmentDetailedExplanation = {
      title: seg.topicTitle,
      corePoints: [
        '基于当前段落转写上下文自动提炼的核心定义与因果链条。',
        '建议结合黄色荧光笔标注的专业术语对照复习。',
      ],
      elaboration: seg.utterances.map((u) => u.refinedText).join(' '),
      thinking: `梳理段落「${seg.topicTitle}」的上下文结构，归纳核心定义与前后知识联系。`,
    };
    seg.detailedExplanation = generated;
    saveDb(db);
    return generated;
  },

  async streamExplainSegment(
    sessionId: string,
    segmentId: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onStageChange?: (stage: 'generating') => void;
    }
  ): Promise<SegmentDetailedExplanation> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    const seg = ws?.segments.find((item) => item.id === segmentId);
    if (!seg) throw new Error('未找到对应知识点段落');
    if (seg.detailedExplanation) {
      return seg.detailedExplanation;
    }
    const thinking = `正在分析段落「${seg.topicTitle}」的核心概念、前后逻辑衔接与易错细节...`;
    callbacks?.onThinkingDelta?.(thinking);
    callbacks?.onStageChange?.('generating');
    return mockAdapter.explainSegment(sessionId, segmentId);
  },

  async sendChatMessage(sessionId: string, content: string): Promise<ChatMessage> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws) throw new Error('未找到课堂上下文');

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sessionId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    ws.messages.push(userMsg);

    const topicList = ws.segments.map((s, idx) => `${idx + 1}. **${s.topicTitle}**`).join('\n');
    const thinking = `检索本堂课 ${ws.segments.length} 段实时转写记录，定位与「${content}」相关的核心段落与公式推导。`;
    const reply: ChatMessage = {
      id: `msg-ai-${Date.now() + 1}`,
      sessionId,
      role: 'assistant',
      referencedSegmentCount: ws.segments.length,
      thinking,
      content: `已结合本堂课实时识别的 **${ws.segments.length}** 个知识点段落为您整理要点：\n\n${topicList}\n\n针对您提出的「${content}」，建议重点关注课堂转写中荧光笔标注的核心概念及因果推导条件。`,
      createdAt: new Date().toISOString(),
    };
    ws.messages.push(reply);
    saveDb(db);
    return reply;
  },

  async streamChatMessage(
    sessionId: string,
    content: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onContentDelta?: (delta: string) => void;
    }
  ): Promise<ChatMessage> {
    const reply = await mockAdapter.sendChatMessage(sessionId, content);
    if (reply.thinking) {
      callbacks?.onThinkingDelta?.(reply.thinking);
    }
    callbacks?.onContentDelta?.(reply.content);
    return reply;
  },

  async getSettings(): Promise<AppSettings> {
    const db = loadDb();
    return db.settings;
  },

  async updateSettings(settings: AppSettings): Promise<AppSettings> {
    const db = loadDb();
    db.settings = settings;
    saveDb(db);
    return db.settings;
  },

  async fetchLlmModels(providerId: string): Promise<string[]> {
    if (providerId === OPENCODE_FREE_PROVIDER_ID) {
      throw new Error('OpenCode 免费模型需要连接本机后端才能拉取');
    }
    const preset = LLM_PROVIDER_PRESETS.find((p) => p.id === providerId);
    return preset ? [...preset.defaultSampleModels] : ['custom-model-v1', 'custom-model-pro'];
  },

  async fetchAsrModels(providerId: string): Promise<string[]> {
    const preset = ASR_PROVIDER_PRESETS.find((p) => p.id === providerId);
    return preset ? [...preset.defaultModels] : ['custom-asr-streaming-v1'];
  },

  async getAec3AddonStatus(): Promise<Aec3AddonStatus> {
    const installed = localStorage.getItem('zhiling_mock_aec3_installed') === '1';
    return { installed, version: '0.3.0', sizeBytes: 204128 };
  },

  async streamDownloadAec3Addon(
    onProgress?: (progress: Aec3DownloadProgress) => void
  ): Promise<Aec3AddonStatus> {
    const steps: Aec3DownloadProgress[] = [
      { stage: 'connecting', downloadedBytes: 0, totalBytes: 309218, percent: 8 },
      { stage: 'downloading', downloadedBytes: 154609, totalBytes: 309218, percent: 52 },
      { stage: 'verifying', downloadedBytes: 309218, totalBytes: 309218, percent: 95 },
      { stage: 'ready', downloadedBytes: 309218, totalBytes: 309218, percent: 100 },
    ];
    for (const step of steps) {
      onProgress?.(step);
      await new Promise((r) => window.setTimeout(r, 80));
    }
    localStorage.setItem('zhiling_mock_aec3_installed', '1');
    return { installed: true, version: '0.3.0', sizeBytes: 204128 };
  },

  async getNativeAudioDevices(): Promise<NativeAudioDevices> {
    return {
      platform: 'browser',
      wasapiSupported: false,
      inputs: [],
      loopbacks: [],
    };
  },

  async streamSessionNotes(
    sessionId: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onContentDelta?: (delta: string) => void;
    }
  ): Promise<SessionStudyNote> {
    const db = loadDb();
    const session = db.sessions.find((s) => s.id === sessionId);
    const ws = db.workspaces[sessionId];
    if (!session || !ws) throw new Error('未找到对应课堂');
    const thinking = `正在梳理《${session.title}》共 ${ws.segments.length} 个知识分段的逻辑层次与核心术语...`;
    callbacks?.onThinkingDelta?.(thinking);
    const topics = ws.segments
      .map((s) => `- **[0${s.orderIndex}:15] ${s.topicTitle}**：涵盖 ${s.highlights.map((h) => h.term).join('、') || '核心原理推导'}`)
      .join('\n');
    const contentMarkdown = `## 一、课程核心导览\n本堂课围绕 **${session.title}** 展开，系统构建了从基础背景到公式化建模的知识闭环。\n\n## 二、知识体系与分段精要\n${topics}\n\n## 三、核心公式、推导与代码精解\n重点关注归一化缩放机制与复杂度边界分析。\n\n## 四、易错警示、难点突破与课后待办\n- 复盘各分段荧光笔术语的定义适用前提\n- 完成课后推导与代码边界验证`;
    callbacks?.onContentDelta?.(contentMarkdown);
    const note: SessionStudyNote = {
      contentMarkdown,
      thinking,
      updatedAt: new Date().toISOString(),
    };
    ws.studyNote = note;
    saveDb(db);
    return note;
  },

  async generateFlashcards(sessionId: string): Promise<FlashcardItem[]> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws) throw new Error('未找到对应课堂');
    const cards: FlashcardItem[] = [];
    for (const seg of ws.segments) {
      for (const hl of seg.highlights) {
        cards.push({
          id: `fc-${hl.id}`,
          front: `请解释课堂核心概念「${hl.term}」的作用与定义？`,
          back: hl.explanation,
          tag: seg.topicTitle,
        });
      }
    }
    if (cards.length === 0) {
      cards.push({
        id: `fc-${Date.now()}`,
        front: '本堂课最核心的推导结论是什么？',
        back: '结合各分段标题梳理输入条件与目标输出之间的映射关系。',
        tag: '课堂核心',
      });
    }
    ws.flashcards = cards;
    saveDb(db);
    return cards;
  },

  async exportSessionDocument(
    sessionId: string,
    req: SessionExportRequest
  ): Promise<{ blob: Blob; filename: string }> {
    const db = loadDb();
    const session = db.sessions.find((s) => s.id === sessionId);
    const ws = db.workspaces[sessionId];
    if (!session || !ws) throw new Error('未找到对应课堂');
    const ext = req.format === 'markdown' ? 'md' : req.format === 'anki' ? 'tsv' : req.format;
    const content = `# ${session.title}\n\n${ws.studyNote?.contentMarkdown ?? ''}\n`;
    return {
      blob: new Blob([content], { type: 'text/plain;charset=utf-8' }),
      filename: `${session.title}.${ext}`,
    };
  },

  async patchUtterance(
    sessionId: string,
    utteranceId: string,
    patch: UtterancePatch
  ): Promise<UtteranceItem> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws) throw new Error('未找到对应课堂');
    for (const seg of ws.segments) {
      const target = seg.utterances.find((u) => u.id === utteranceId);
      if (target) {
        if (patch.refinedText !== undefined) {
          target.refinedText = patch.refinedText;
          target.isRefined = true;
          target.isManualEdited = true;
        }
        if (patch.isBookmarked !== undefined) {
          target.isBookmarked = patch.isBookmarked;
          if (!patch.isBookmarked) target.bookmarkKind = null;
        }
        if (patch.bookmarkKind !== undefined) {
          target.bookmarkKind = patch.bookmarkKind;
          if (patch.bookmarkKind) target.isBookmarked = true;
        }
        if (patch.userNote !== undefined) {
          target.userNote = patch.userNote || null;
        }
        saveDb(db);
        return { ...target };
      }
    }
    throw new Error('未找到对应转写句');
  },

  async bookmarkNow(
    sessionId: string,
    kind: 'confused' | 'important' = 'confused',
    note?: string
  ): Promise<{ segmentId: string; utterance: UtteranceItem }> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws || ws.segments.length === 0) throw new Error('当前课堂暂无转写可标记');
    const lastSeg = ws.segments[ws.segments.length - 1];
    const lastUtt = lastSeg.utterances[lastSeg.utterances.length - 1];
    if (!lastUtt) throw new Error('当前课堂暂无转写可标记');
    lastUtt.isBookmarked = true;
    lastUtt.bookmarkKind = kind;
    if (note?.trim()) lastUtt.userNote = note.trim();
    saveDb(db);
    return { segmentId: lastSeg.id, utterance: { ...lastUtt } };
  },

  async uploadAttachment(
    sessionId: string,
    file: Blob,
    options: {
      fileName: string;
      kind?: 'screenshot' | 'image' | 'material';
      segmentId?: string;
      timestampMs?: number;
      caption?: string;
    }
  ): Promise<SessionAttachmentItem> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws) throw new Error('未找到对应课堂');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取本地文件失败'));
      reader.readAsDataURL(file);
    });
    const item: SessionAttachmentItem = {
      id: `att-${Date.now()}`,
      sessionId,
      segmentId: options.segmentId ?? ws.segments[ws.segments.length - 1]?.id ?? null,
      kind: options.kind ?? (file.type.startsWith('image/') ? 'image' : 'material'),
      fileName: options.fileName,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      timestampMs: options.timestampMs ?? 0,
      timestampText: '00:00',
      caption: options.caption,
      url: dataUrl,
      createdAt: new Date().toISOString(),
    };
    ws.attachments = [...(ws.attachments ?? []), item];
    saveDb(db);
    return item;
  },

  async deleteAttachment(sessionId: string, attachmentId: string): Promise<void> {
    const db = loadDb();
    const ws = db.workspaces[sessionId];
    if (!ws) return;
    ws.attachments = (ws.attachments ?? []).filter((a) => a.id !== attachmentId);
    saveDb(db);
  },

  async searchGlobal(query: string, folderId?: string | null): Promise<SearchHitItem[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const db = loadDb();
    const hits: SearchHitItem[] = [];
    for (const s of db.sessions) {
      if (folderId && s.folderId !== folderId) continue;
      if (s.title.toLowerCase().includes(q)) {
        hits.push({
          sessionId: s.id,
          sessionTitle: s.title,
          folderId: s.folderId,
          kind: 'title',
          snippet: s.title,
          updatedAt: s.updatedAt,
        });
      }
      const ws = db.workspaces[s.id];
      if (!ws) continue;
      for (const seg of ws.segments) {
        for (const u of seg.utterances) {
          const txt = u.refinedText || u.rawText;
          if (txt.toLowerCase().includes(q)) {
            hits.push({
              sessionId: s.id,
              sessionTitle: s.title,
              folderId: s.folderId,
              kind: 'utterance',
              segmentId: seg.id,
              utteranceId: u.id,
              timestampMs: u.startTimeMs,
              timestampText: u.timestampText,
              snippet: txt.slice(0, 96),
              updatedAt: s.updatedAt,
            });
          }
        }
      }
    }
    return hits.slice(0, 30);
  },

  async streamImportAudio(
    file: Blob,
    options: { fileName: string; title?: string; folderId?: string | null },
    onProgress?: (p: AudioImportProgress) => void
  ): Promise<SessionWorkspacePayload> {
    onProgress?.({ stage: 'decoding', downloadedBytes: 0, totalBytes: file.size, percent: 20 });
    await new Promise((r) => window.setTimeout(r, 120));
    onProgress?.({ stage: 'transcribing', downloadedBytes: file.size, totalBytes: file.size, percent: 70 });
    const created = await mockAdapter.createSession(options.folderId ?? null);
    const cleanTitle = options.title?.trim() || options.fileName.replace(/\.[^.]+$/, '');
    await mockAdapter.updateSession(created.session.id, { title: cleanTitle, status: 'paused', durationSeconds: 120 });
    onProgress?.({ stage: 'refining', downloadedBytes: file.size, totalBytes: file.size, percent: 95 });
    return mockAdapter.getSessionWorkspace(created.session.id);
  },
};
