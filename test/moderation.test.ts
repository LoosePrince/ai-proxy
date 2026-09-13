/**
 * 内容审核 core 层单测。
 *
 * 覆盖纯函数：类别体系、归一化、内置词库、组合判定、策略编译与作用域解析、
 * 流式滞后守卫。全部不需要数据库或 HTTP。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ModerationCategory, ModerationPolicyDTO } from '../src/types/api';
import { MODERATION_CATEGORIES, categoryChain, sensitivityThreshold } from '../src/core/moderation/taxonomy';
import { deLeet, normalizeForms } from '../src/core/moderation/normalize';
import { DEFAULT_LEXICON, scanLexicon, scoreFromMatchCount } from '../src/core/moderation/lexicon';
import { listDetectorInfo } from '../src/core/moderation/detectors';
import { combineDecision, evaluateText } from '../src/core/moderation/evaluate';
import { compileModerationConfig, compilePolicy, materializeCategorySettings, parseModerationKeywords, resolveModerationPolicy } from '../src/core/moderation/compile';
import { StreamModerationGuard } from '../src/core/moderation/stream-guard';
import { payloadUserText, responseText, splitSseFrames } from '../src/core/moderation/text';

function basePolicy(overrides: Partial<ModerationPolicyDTO> = {}): ModerationPolicyDTO {
  return {
    id: 1,
    name: 'test',
    description: '',
    enabled: true,
    isDefault: true,
    combineMode: 'strict',
    action: 'empty',
    outputAction: 'empty',
    outputResponse: 'blocked',
    response: '',
    holdBackChars: 96,
    forbiddenKeywords: '',
    categories: [{ category: 'profanity', enabled: true, sensitivity: 50 }],
    detectors: [{ detectorId: 'builtin-lexicon', enabled: true, categories: [] }],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('moderation taxonomy', () => {
  it('敏感度越高阈值越低，且被夹在 0..0.99', () => {
    assert.equal(sensitivityThreshold(100), 0);
    assert.equal(sensitivityThreshold(0), 0.99);
    assert.equal(sensitivityThreshold(50), 0.5);
    assert.equal(sensitivityThreshold(-10), 0.99);
    assert.equal(sensitivityThreshold(999), 0);
  });

  it('类别链包含自身与全部祖先', () => {
    assert.deepEqual(categoryChain('violence/graphic'), ['violence/graphic', 'violence']);
    assert.deepEqual(categoryChain('profanity'), ['profanity']);
  });
});

describe('moderation normalize', () => {
  it('还原 leet 与去除不可见字符', () => {
    assert.equal(deLeet('sh1t'), 'shit');
    assert.equal(normalizeForms('f\u200buck').readable, 'f uck');
    assert.equal(normalizeForms('f u c k').compact, 'fuck');
  });

  it('紧凑形态不区分标点与空格', () => {
    assert.equal(normalizeForms('f.u.c.k!').compact, 'fuck');
  });
});

describe('moderation lexicon', () => {
  it('按类别命中并给出分数', () => {
    const result = scanLexicon('you are a fucking idiot', ['profanity'], []);
    assert.ok(result.categories.has('profanity'));
    assert.equal(scoreFromMatchCount(1), 0.5);
    assert.equal(scoreFromMatchCount(2), 0.75);
  });

  it('抵抗 leet 与插入空格', () => {
    assert.equal(scanLexicon('n1gger', ['hate'], []).categories.has('hate'), true);
    assert.equal(scanLexicon('s h i t', ['profanity'], []).categories.has('profanity'), true);
  });

  it('未启用的类别不参与匹配', () => {
    const result = scanLexicon('fucking idiot', ['hate'], []);
    assert.equal(result.categories.size, 0);
  });

  it('自定义违禁词归入 profanity', () => {
    const result = scanLexicon('请勿讨论某某内部代号', ['profanity'], ['某某内部代号']);
    assert.ok(result.customMatches.length > 0);
  });

  it('默认词库覆盖全部声明类别', () => {
    for (const category of MODERATION_CATEGORIES) {
      assert.ok(Array.isArray(DEFAULT_LEXICON[category]), `缺少类别词库：${category}`);
    }
  });
});

describe('moderation detectors', () => {
  it('内置词库始终可用', () => {
    const info = listDetectorInfo();
    const builtin = info.find((detector) => detector.id === 'builtin-lexicon');
    assert.ok(builtin);
    assert.equal(builtin.available, true);
    assert.equal(builtin.nativeCategories, true);
  });

  it('可选依赖引擎标注依赖包名，可用时不带失败原因', () => {
    const info = listDetectorInfo();
    const visulima = info.find((detector) => detector.id === 'visulima');
    assert.ok(visulima);
    assert.equal(visulima.dependency, '@visulima/content-safety');
    // 本仓库已安装全部可选依赖；一旦某个引擎不可用，必须给出原因与修复建议，
    // 否则后台只能显示「未安装」，排查无从下手。
    for (const detector of info) {
      if (detector.id === 'builtin-lexicon') assert.equal(detector.dependency, null);
      if (detector.available) {
        assert.equal(detector.reason, null, `${detector.id} 可用时不应带原因`);
        assert.equal(detector.hint, null, `${detector.id} 可用时不应带修复建议`);
      } else {
        assert.ok(detector.reason, `${detector.id} 不可用时必须说明原因`);
        assert.ok(detector.hint, `${detector.id} 不可用时必须给出修复建议`);
      }
    }
  });
});

describe('moderation combine', () => {
  it('strict 任一命中即拦截', () => {
    assert.equal(combineDecision('strict', 1, 3), true);
    assert.equal(combineDecision('strict', 0, 3), false);
  });

  it('majority 需要超过半数', () => {
    assert.equal(combineDecision('majority', 2, 3), true);
    assert.equal(combineDecision('majority', 1, 3), false);
    assert.equal(combineDecision('majority', 1, 2), false);
  });

  it('lenient 需要全部命中', () => {
    assert.equal(combineDecision('lenient', 3, 3), true);
    assert.equal(combineDecision('lenient', 2, 3), false);
  });

  it('没有可用引擎时永不拦截', () => {
    assert.equal(combineDecision('strict', 0, 0), false);
    assert.equal(combineDecision('lenient', 0, 0), false);
  });
});

describe('moderation evaluate', () => {
  it('内置词库命中 profanity 时拦截并带回类别', () => {
    const policy = compilePolicy(basePolicy());
    const decision = evaluateText('this is fucking bad', policy, 'input');
    assert.equal(decision.blocked, true);
    assert.ok(decision.categories.includes('profanity'));
    assert.deepEqual(decision.detectorIds, ['builtin-lexicon']);
    assert.equal(decision.action, 'empty');
  });

  it('低敏感度下单次命中不触发（分数 0.5 < 阈值）', () => {
    const policy = compilePolicy(
      basePolicy({ categories: [{ category: 'profanity', enabled: true, sensitivity: 10 }] }),
    );
    assert.equal(evaluateText('damn', policy, 'input').blocked, false);
  });

  it('敏感度 100 时任何命中都拦截', () => {
    const policy = compilePolicy(
      basePolicy({ categories: [{ category: 'profanity', enabled: true, sensitivity: 100 }] }),
    );
    assert.equal(evaluateText('damn', policy, 'input').blocked, true);
  });

  it('干净文本不拦截', () => {
    const policy = compilePolicy(basePolicy());
    assert.equal(evaluateText('please summarise this document', policy, 'input').blocked, false);
  });
});

describe('moderation compile & scope', () => {
  it('未显式配置的子类别继承父类别', () => {
    const materialized = materializeCategorySettings([{ category: 'sexual', enabled: true, sensitivity: 80 }]);
    const child = materialized.find((item) => item.category === 'sexual/minors');
    assert.ok(child?.enabled);
    assert.equal(child?.sensitivity, 80);
  });

  it('显式关闭的子类别不受父类别影响', () => {
    const materialized = materializeCategorySettings([
      { category: 'sexual', enabled: true, sensitivity: 80 },
      { category: 'sexual/minors', enabled: false, sensitivity: 80 },
    ]);
    assert.equal(materialized.find((item) => item.category === 'sexual/minors')?.enabled, false);
  });

  it('作用域优先级：模型级 > Provider 级 > 全局默认', () => {
    const global = basePolicy({ id: 1, name: 'global', isDefault: true });
    const provider = basePolicy({ id: 2, name: 'provider', isDefault: false });
    const model = basePolicy({ id: 3, name: 'model', isDefault: false });
    const config = compileModerationConfig(
      [global, provider, model],
      [
        { scopeType: 'provider', providerId: 7, model: null, policyId: 2 },
        { scopeType: 'model', providerId: 7, model: 'gpt-4o', policyId: 3 },
      ],
    );

    assert.equal(resolveModerationPolicy(config, 7, 'gpt-4o')?.name, 'model');
    assert.equal(resolveModerationPolicy(config, 7, 'other')?.name, 'provider');
    assert.equal(resolveModerationPolicy(config, 9, 'anything')?.name, 'global');
    assert.equal(resolveModerationPolicy(config, null, null)?.name, 'global');
  });

  it('停用的策略不参与解析，绑定退回全局默认', () => {
    const global = basePolicy({ id: 1, name: 'global', isDefault: true });
    const disabled = basePolicy({ id: 2, name: 'disabled', enabled: false });
    const config = compileModerationConfig(
      [global, disabled],
      [{ scopeType: 'provider', providerId: 7, model: null, policyId: 2 }],
    );
    assert.equal(resolveModerationPolicy(config, 7, null)?.name, 'global');
  });

  it('解析违禁词支持换行与中英文逗号', () => {
    assert.deepEqual(parseModerationKeywords('a\nb, c，d'), ['a', 'b', 'c', 'd']);
  });
});

describe('moderation stream guard', () => {
  const policy = compilePolicy(
    basePolicy({
      holdBackChars: 5,
      categories: [{ category: 'profanity', enabled: true, sensitivity: 100 }],
    }),
  );

  it('滞后窗口内先缓冲，再按序放行', () => {
    const guard = new StreamModerationGuard(policy);
    assert.equal(guard.pushEvent('r1', 'abc').release, '');
    assert.equal(guard.pushEvent('r2', 'def').release, '');
    assert.equal(guard.pushEvent('r3', 'ghi').release, 'r1');
    const tail = guard.flush();
    assert.equal(tail.decision, null);
    assert.equal(tail.release, 'r2r3');
  });

  it('跨帧拆词也能拦截（fu + ck）', () => {
    const guard = new StreamModerationGuard(policy);
    guard.pushEvent('a', 'fu');
    const result = guard.pushEvent('b', 'ck');
    // 要么在本次 push 命中，要么在 flush 命中，二者必有其一
    const decision = result.decision ?? guard.flush().decision;
    assert.ok(decision, '跨帧违禁词未被拦截');
    assert.equal(decision?.stage, 'output');
  });

  it('已放行的干净前缀不受后续命中影响（窗口内）', () => {
    const guard = new StreamModerationGuard(policy);
    const first = guard.pushEvent('a', 'hello ');
    assert.equal(first.decision, null);
    const blocked = guard.pushEvent('b', 'fuck');
    const decision = blocked.decision ?? guard.flush().decision;
    assert.ok(decision);
    assert.equal(decision?.blocked, true);
  });

  it('终止时不放行被拦截的正文', () => {
    const guard = new StreamModerationGuard(policy);
    guard.pushEvent('a', 'fu');
    const result = guard.pushEvent('b', 'ck');
    assert.equal(result.release, '');
  });
});

describe('moderation text extraction', () => {
  it('请求侧跳过 system/developer 消息', () => {
    const payload = {
      messages: [
        { role: 'system', content: 'fucking rules' },
        { role: 'user', content: 'hello' },
      ],
    };
    assert.equal(payloadUserText(payload), 'hello');
  });

  it('响应侧提取正文与思考内容', () => {
    const body = {
      choices: [{ message: { content: 'answer', reasoning_content: 'thinking' } }],
    };
    const text = responseText(body);
    assert.ok(text.includes('answer'));
    assert.ok(text.includes('thinking'));
  });

  it('SSE 拆帧保留不完整残片', () => {
    const { frames, rest } = splitSseFrames('', 'data: a\n\ndata: b\n\npartial');
    assert.equal(frames.length, 2);
    assert.equal(rest, 'partial');
  });
});

// 确保类别类型在测试里被使用，避免类型导入被误删
const _typecheck: ModerationCategory = 'profanity';
void _typecheck;
