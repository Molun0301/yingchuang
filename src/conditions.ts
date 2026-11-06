// 只解释作者控件条件中的比较和布尔运算，不执行主题脚本。
export function conditionVisible(condition: string|undefined, values: Record<string,unknown>): boolean {
  if (!condition?.trim()) return true;
  const tokens = condition.match(/(?:[A-Za-z_$][\w$]*)(?:\.value)?|===|!==|==|!=|>=|<=|&&|\|\||[()!<>]|-?(?:\d*\.\d+|\d+)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g) || [];
  let index=0;
  function primary(): unknown {
    const token=tokens[index++];
    if (token==='!') return !primary();
    if (token==='(') { const value=or();if(tokens[index++]!==')')throw new Error();return value; }
    if (token==='true')return true;if(token==='false')return false;if(token==='null')return null;
    if (!token)throw new Error();
    if (/^["']/.test(token))return token.slice(1,-1);
    if (/^-?(?:\d|\.\d)/.test(token))return Number(token);
    return values[token.replace(/\.value$/,'')];
  }
  function compare(): unknown {
    let a=primary();const op=tokens[index];
    if (['==','===','!=','!==','>','<','>=','<='].includes(op)) {
      index++;const b=primary();
      if(op==='==')a=a==b;if(op==='===')a=a===b;
      if(op==='!=')a=a!=b;if(op==='!==')a=a!==b;
      if(op==='>')a=Number(a)>Number(b);if(op==='<')a=Number(a)<Number(b);
      if(op==='>=')a=Number(a)>=Number(b);if(op==='<=')a=Number(a)<=Number(b);
    }
    return a;
  }
  function and(): unknown {let a=compare();while(tokens[index]==='&&'){index++;const b=compare();a=Boolean(a)&&Boolean(b);}return a;}
  function or(): unknown {let a=and();while(tokens[index]==='||'){index++;const b=and();a=Boolean(a)||Boolean(b);}return a;}
  try { const result=or();return index===tokens.length?Boolean(result):true; } catch {return true;}
}

export function colorHex(value:unknown):string {
  if(typeof value==='string' && /^#[\da-f]{6}$/i.test(value))return value;
  const rgb=String(value||'1 1 1').split(/\s+/).slice(0,3).map(Number);
  if(rgb.length!==3 || rgb.some(x=>!Number.isFinite(x)))return '#ffffff';
  return '#'+rgb.map(x=>Math.round(Math.max(0,Math.min(1,x))*255).toString(16).padStart(2,'0')).join('');
}
export const sourceColor=(hex:string)=>[1,3,5].map(i=>(parseInt(hex.slice(i,i+2),16)/255).toFixed(6)).join(' ');
