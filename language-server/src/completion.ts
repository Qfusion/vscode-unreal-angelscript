import {
    TextDocumentPositionParams, CompletionItem, CompletionItemKind, SignatureHelp,
    SignatureInformation, ParameterInformation, Hover, MarkupContent, SymbolInformation,
    TextDocument, SymbolKind, Definition, Location, InsertTextFormat, TextEdit,
    Range, Position
} from 'vscode-languageserver';

import * as scriptfiles from './as_file';
import * as typedb from './database';

enum ASTermType
{
    Name,
    Namespace,
    PropertyAccess,
    FunctionCall,
    IndexOperator,
    ImportStatement
};

class ASTerm
{
    type : ASTermType;
    name : string;
};

function ParseTerms(strTerm : string) : Array<ASTerm>
{
    let terms = new Array<ASTerm>();

    let termPos = 0;
    let brackets = 0;
    let pos = 0;
    let squarebrackets = 0;

    let finalizeTerm = function() 
    {
        if(pos > termPos)
        {
            terms.push(<ASTerm> {
                type: ASTermType.Name,
                name: strTerm.substring(termPos, pos),
            });
        }
    };

    for (pos = 0; pos < strTerm.length; ++pos)
    {
        let char = strTerm[pos];
        switch (char)
        {
            case ".":
                if (brackets == 0 && squarebrackets == 0)
                {
                    finalizeTerm();
                    terms.push(<ASTerm> {
                        type: ASTermType.PropertyAccess
                    });
                    termPos = pos+1;
                }
            break;
            case ":":
                if (brackets == 0 && squarebrackets == 0 && pos > 0 && strTerm[pos-1] == ":")
                {
                    pos -= 1;
                    finalizeTerm();
                    pos += 1;

                    terms.push(<ASTerm> {
                        type: ASTermType.Namespace
                    });
                    termPos = pos+1;
                }
            break;
            case "(":
                if (brackets == 0 && squarebrackets == 0)
                {
                    finalizeTerm();
                    terms.push(<ASTerm> {
                        type: ASTermType.FunctionCall
                    });
                }
                brackets += 1;
            break;
            case ")":
                brackets -= 1;
                if (brackets == 0 && squarebrackets == 0)
                    termPos = pos+1;
            break;
            case "[":
                if (squarebrackets == 0 && brackets == 0)
                {
                    finalizeTerm();
                    terms.push(<ASTerm> {
                        type: ASTermType.IndexOperator
                    });
                }
                squarebrackets += 1;
            break;
            case "]":
                squarebrackets -= 1;
                if (squarebrackets == 0 && brackets == 0)
                    termPos = pos+1;
            break;
        }
    }

    terms.push(<ASTerm> {
        type: ASTermType.Name,
        name: strTerm.substring(termPos, strTerm.length)
    });

    return terms;
}

function ExtractCompletingTerm(params : TextDocumentPositionParams) : [Array<ASTerm>, scriptfiles.ASScope]
{
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos == -1)
        return [[], null];
    return ExtractCompletingTermAt(pos, params.textDocument.uri);
}

function ExtractCompletingTermAt(pos : number, uri : string) : [Array<ASTerm>, scriptfiles.ASScope]
{
    let file = scriptfiles.GetFile(uri);
    if (file == null)
        return [[], null];
    let termstart = pos;
    let brackets = 0;
    let braces = 0;
    let squarebrackets = 0;
    while (termstart > 0)
    {
        let char = file.rootscope.content[termstart];
        let end = false;

        switch(char)
        {
            case ';': end = true; break;
            case '[':
                if(squarebrackets > 0)
                    squarebrackets -= 1;
                else end = true;
            break;
            case ']':
                squarebrackets += 1;
            break;
            case '(':
                if(brackets > 0)
                    brackets -= 1;
                else end = true;
            break;
            case ')':
                brackets += 1;
            break;
            case '{':
            case '}':
            case '/':
            case '+':
            case '-':
            case '=':
            case '*':
            case '@':
            case '!':
            case ' ':
            case '<':
            case '\n':
            case '&':
            case '~':
            case '^':
                if(brackets == 0 && squarebrackets == 0)
                    end = true;
            break;
        }

        if(end)
        {
            termstart += 1;
            break;
        }
        termstart -= 1;
    }

    let fullTerm = file.rootscope.content.substring(termstart, pos+1).trim();
    let scope = file.GetScopeAt(pos);

    if (termstart >= 7)
    {
        let importBefore = file.rootscope.content.substr(termstart-7, 7);
        if (importBefore == "import ")
        {
            return [[
                <ASTerm> {
                    type: ASTermType.ImportStatement,
                    name: fullTerm
                }
            ], scope];
        }
    }

    return [ParseTerms(fullTerm), scope];
}

function CanCompleteTo(completing : string, suggestion : string) : boolean
{
    if (completing.startsWith("get_"))
    {
        if (suggestion.startsWith("get_"))
            return suggestion.substr(4).toLowerCase().indexOf(completing.substr(4).toLowerCase()) != -1;
    }
    else if (completing.startsWith("set_"))
    {
        if (suggestion.startsWith("set_"))
            return suggestion.substr(4).toLowerCase().indexOf(completing.substr(4).toLowerCase()) != -1;
    }

    return suggestion.toLowerCase().indexOf(completing.toLowerCase()) != -1;
}

function GetTypeCompletions(initialTerm : string, completions : Array<CompletionItem>)
{
    for (let [typename, dbtype] of typedb.GetDatabase())
    {
        if (dbtype.isShadowedNamespace())
            continue;

        let kind : CompletionItemKind = CompletionItemKind.Class;
        if (dbtype.isNamespace())
        {
            typename = dbtype.rawName;
            kind = CompletionItemKind.Module;
        }

        if (typename.startsWith("//"))
            continue;

        if (CanCompleteTo(initialTerm, typename))
        {
            completions.push({
                    label: typename,
                    detail: typename,
                    kind : kind,
                    data : [dbtype.typename],
            });
        }
    }
}

function GetGlobalScopeTypes(scope : scriptfiles.ASScope, includeClass : boolean, includeRoot : boolean = true) : Array<typedb.DBType>
{
    let types = new Array<typedb.DBType>();

    let glob = typedb.GetType("__");
    if(glob && includeRoot)
        types.push(glob);

    let checkScope = scope;
    let checkedScope = scope;
    while (checkScope)
    {
        if (checkScope.scopetype == scriptfiles.ASScopeType.Global
            || (includeClass && checkScope.scopetype == scriptfiles.ASScopeType.Class))
        {
            let dbscope = typedb.GetType(checkScope.typename);
            if(dbscope)
                types.push(dbscope);
        }
        if (checkScope.scopetype == scriptfiles.ASScopeType.Global) {
            checkedScope = checkScope;
        }
        checkScope = checkScope.parentscope;
    }

    for (let file of scriptfiles.GetAllFiles())
    {
        checkScope = file.rootscope;
        if (checkScope.scopetype != scriptfiles.ASScopeType.Global)
            continue;

        if (checkScope != checkedScope) {
            let dbscope = typedb.GetType(checkScope.typename);
            if(dbscope)
                types.push(dbscope);
        }

        // spill enum values into global scope
        for (let subscope of checkScope.subscopes) {
            if (subscope.scopetype != scriptfiles.ASScopeType.Enum) {
                continue
            }
            let dbscope = typedb.GetType("__"+subscope.typename);
            if(dbscope)
                types.push(dbscope);
        }
    }

    return types;
}

function GetScopeCompletions(initialTerm : string, scope : scriptfiles.ASScope, completions : Array<CompletionItem>)
{
    if (scope.scopetype != scriptfiles.ASScopeType.Class
        && scope.scopetype != scriptfiles.ASScopeType.Global
    )
    {
        for (let scopevar of scope.variables)
        {
            if (CanCompleteTo(initialTerm, scopevar.name))
            {
                completions.push({
                        label: scopevar.name,
                        detail: scopevar.typename + " " + scopevar.name,
                        kind : CompletionItemKind.Variable
                });
            }
        }
    }

    if (scope.parentscope)
        GetScopeCompletions(initialTerm, scope.parentscope, completions);
}

function GetVariableType(variable : string, scope : scriptfiles.ASScope) : string | null
{
    for (let scopevar of scope.variables)
    {
        if (scopevar.name == variable)
        {
            return scopevar.typename;
        }
    }

    if (variable == "this") {
        if (scope.scopetype == scriptfiles.ASScopeType.Function && scope.parentscope.scopetype == scriptfiles.ASScopeType.Class) {
            return scope.parentscope.typename;
        }
    }

    if (scope.parentscope)
        return GetVariableType(variable, scope.parentscope);
    return null;
}

function ResolvePropertyType(term : string, type : typedb.DBType, scope : scriptfiles.ASScope) : typedb.DBType
{
    if (scope != null)
    {
        let typename = GetVariableType(term, scope);
        if (typename != null)
        {
            let dbtype = typedb.GetType(typename);
            if (dbtype != null)
                return dbtype;
        }
    }

    if (type == null && scope != null)
    {
        let globaltypes = GetGlobalScopeTypes(scope, true);
        for (let globaltype of globaltypes)
        {
            let prop = globaltype.getProperty(term);
            if (prop != null)
            {
                return typedb.GetType(prop.typename);
            }

            let accessortype = globaltype.getPropertyAccessorType(term);
            if (accessortype)
            {
                return typedb.GetType(accessortype);
            }
        }
    }
    else if (type != null)
    {
        let prop = type.getProperty(term);
        if (prop != null)
        {
            return typedb.GetType(prop.typename);
        }

        let accessortype = type.getPropertyAccessorType(term);
        if (accessortype)
        {
            return typedb.GetType(accessortype);
        }
    }

    return null;
}

function GetFunctionRetType(name : string, scope : scriptfiles.ASScope) : string | null
{
    for (let subscope of scope.subscopes)
    {
        if (subscope.scopetype == scriptfiles.ASScopeType.Function && subscope.funcname == name)
        {
            return subscope.funcreturn;
        }
    }

    if (scope.parentscope)
        return GetFunctionRetType(name, scope.parentscope);
    return null;
}

function ResolveFunctionType(term : string, type : typedb.DBType, scope : scriptfiles.ASScope, globScope : scriptfiles.ASScope = null) : typedb.DBType
{
    if (type == null && scope != null)
    {
        let globaltypes = GetGlobalScopeTypes(scope, true);
        for (let globaltype of globaltypes)
        {
            let mthd = globaltype.getMethod(term);
            if(mthd)
            {
                let dbtype = typedb.GetType(mthd.returnType);
                if(dbtype)
                    return dbtype;
            }
        }
    }

    if (type != null)
    {
        let func = type.getMethod(term);
        if (func)
        {
            return typedb.GetType(func.returnType);
        }

        if (globScope != null)
        {
            // Deal with unified call syntax from global functions
            let ucsScopes = GetGlobalScopeTypes(globScope, false, false);
            for (let globaltype of ucsScopes)
            {
                let func = globaltype.getMethod(term);
                if (func)
                {
                    return typedb.GetType(func.returnType);
                }
            }
        }
    }

    return null;
}

let re_cast = /Cast<([A-Za-z0-9_]+)>/;
function GetTypeFromTerm(initialTerm : Array<ASTerm>, startIndex : number, endIndex : number, scope : scriptfiles.ASScope, finalizeResolve : boolean = false) : typedb.DBType
{
    // Terms in between the first and last are properties of types
    let curtype : typedb.DBType = null;
    let curname : string = null;
    let curscope : scriptfiles.ASScope = scope;
    let globscope = scope;

    for(let index = startIndex; index < endIndex; ++index)
    {
        let term = initialTerm[index];
        switch(term.type)
        {
            case ASTermType.Name:
                curname = term.name;
            break;
            case ASTermType.PropertyAccess:
                if (curname != null)
                {
                    curtype = ResolvePropertyType(curname, curtype, curscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null)
                    {
                        return null;
                    }
                }
            break;
            case ASTermType.FunctionCall:
                if (curname != null)
                {
                    if (curname.startsWith("Cast"))
                    {
                        let castmatch = re_cast.exec(curname);
                        if (castmatch)
                        {
                            curtype = typedb.GetType(castmatch[1]);
                            curscope = null;
                            curname = null;
                            if (curtype == null)
                                return null;
                            break;
                        }
                    }
                    curtype = ResolveFunctionType(curname, curtype, curscope, globscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null)
                        return null;
                }
            break;
            case ASTermType.IndexOperator:
                if (curname != null)
                {
                    curtype = ResolvePropertyType(curname, curtype, curscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null)
                        return null;
                }

                curtype = ResolveFunctionType("opIndex", curtype, curscope, globscope);
                curscope = null;
                if (curtype == null)
                    return null;
            break;
            case ASTermType.Namespace:
                if (curname != null)
                {
                    curtype = typedb.GetType("__"+curname);
                    curname = null;
                    curscope = null;
                    if (curtype == null)
                        return null;
                }
            break;
        }
    }

    if (finalizeResolve && curname)
        curtype = ResolvePropertyType(curname, curtype, curscope);

    return curtype;
}

function GetTermCompletions(initialTerm : Array<ASTerm>, inScope : scriptfiles.ASScope, completions : Array<CompletionItem>)
{
    let curtype = GetTypeFromTerm(initialTerm, 0, initialTerm.length - 1, inScope);
    if (curtype == null)
        return;

    // The last term is always the name we're trying to complete    
    let completingStr = initialTerm[initialTerm.length - 1].name.toLowerCase();
    AddCompletionsFromType(curtype, completingStr, completions, inScope);

    if (completingStr == "") {
        return;
    }

    // Deal with unified call syntax from global functions
    let globaltypes = GetGlobalScopeTypes(inScope, false, false);
    for (let globaltype of globaltypes)
    {
        for (let func of globaltype.allMethods())
        {
            if(func.args && func.args.length >= 1 && curtype.inheritsFrom(func.args[0].typename))
            {
                if (CanCompleteTo(completingStr, func.name))
                {
                    if(!func.name.startsWith("op"))
                    {
                        completions.push({
                                label: func.name,
                                detail: func.format(null, true),
                                kind: CompletionItemKind.Method,
                                data: [curtype.typename, func.name],
                        });
                    }
                }
            }
        }
    }
}

function isPropertyAccessibleFromScope(curtype : typedb.DBType, prop : typedb.DBProperty, inScope : scriptfiles.ASScope) : boolean
{
    if (prop.isPrivate)
    {
        if (!inScope || !inScope.hasPrivateAccessTo(curtype.typename))
            return false;
    }
    else if (prop.isProtected)
    {
        if (!inScope || !inScope.hasProtectedAccessTo(curtype.typename))
            return false;
    }
    return true;
}

function isFunctionAccessibleFromScope(curtype : typedb.DBType, func : typedb.DBMethod, inScope : scriptfiles.ASScope) : boolean
{
    if (func.isPrivate)
    {
        if (!inScope || !inScope.hasPrivateAccessTo(curtype.typename))
            return false;
    }
    else if (func.isProtected)
    {
        if (!inScope || !inScope.hasProtectedAccessTo(curtype.typename))
            return false;
    }
    return true;
}

export function AddCompletionsFromType(curtype : typedb.DBType, completingStr : string, completions : Array<CompletionItem>, inScope : scriptfiles.ASScope)
{
    let props = new Set<string>();
    for (let prop of curtype.allProperties())
    {
        if (CanCompleteTo(completingStr, prop.name))
        {
            if (!isPropertyAccessibleFromScope(curtype, prop, inScope))
                continue;
            props.add(prop.name);
            completions.push({
                    label: prop.name,
                    detail: prop.format(),
                    kind : curtype.isEnum ? CompletionItemKind.EnumMember : CompletionItemKind.Field,
                    data: [curtype.typename, prop.name],
            });
        }
    }

    let getterStr = "get_"+completingStr;
    for (let func of curtype.allMethods())
    {
        if (func.isDestructor)
            continue;

        if (CanCompleteTo(getterStr, func.name))
        {
            if (!isFunctionAccessibleFromScope(curtype, func, inScope))
                continue;
            let propname = func.name.substr(4);
            if(!props.has(propname) && func.args.length == 0)
            {
                completions.push({
                        label: propname,
                        detail: func.returnType+" "+propname,
                        kind: CompletionItemKind.Field,
                        data: [curtype.typename, func.name],
                });
                props.add(propname);
            }
        }

        if (CanCompleteTo(completingStr, func.name))
        {
            if (!isFunctionAccessibleFromScope(curtype, func, inScope))
                continue;
            if(!func.name.startsWith("op") && !func.name.startsWith("get_") && !func.name.startsWith("set_"))
            {
                completions.push({
                        label: func.name,
                        detail: func.format(),
                        kind: CompletionItemKind.Method,
                        data: [curtype.typename, func.name],
                });
            }
        }
    }
}

function AddKeywordCompletions(completingStr : string, completions : Array<CompletionItem>)
{
    for(let kw of [
        "if", "else", "while", "for",
        "class",
        "void", "float", "bool", "int", "double",
        "null", "return", "true", "false", "this",
        "const", "funcdef", "enum", "is"
    ])
    {
        if (CanCompleteTo(completingStr, kw))
        {
            completions.push({
                    label: kw,
                    kind: CompletionItemKind.Keyword
            });
        }
    }
}

function ImportCompletion(term : string) : Array<CompletionItem>
{
    let completions = new Array<CompletionItem>();

    let untilDot = "";
    let dotPos = term.lastIndexOf(".");
    if (dotPos != -1)
        untilDot = term.substr(0, dotPos+1);

    for (let file of scriptfiles.GetAllFiles())
    {
        if (CanCompleteTo(term, file.modulename))
        {
            completions.push({
                label: file.modulename,
                kind: CompletionItemKind.File,
                insertText: file.modulename.substr(untilDot.length),
            });
        }
    }
    return completions;
}

export function Complete(params : TextDocumentPositionParams) : Array<CompletionItem>
{
    let [initialTerm, inScope] = ExtractCompletingTerm(params);

    if (initialTerm.length == 1 && initialTerm[0].type == ASTermType.ImportStatement)
        return ImportCompletion(initialTerm[0].name);

    let completions = new Array<CompletionItem>();

    // Add completions local to the angelscript scope
    let allowScopeCompletions = initialTerm.length == 1;
    if (allowScopeCompletions && inScope != null)
    {
        GetScopeCompletions(initialTerm[0].name, inScope, completions);
    }

    // If we're not inside a type, also complete to type names for static functions / declarations
    if (allowScopeCompletions)
    {
        GetTypeCompletions(initialTerm[0].name, completions);
    }
    
    // If we're not inside a type, also complete to anything is global scope
    if (allowScopeCompletions)
    {
        let globaltypes = GetGlobalScopeTypes(inScope, true);
        for(let globaltype of globaltypes)
            AddCompletionsFromType(globaltype, initialTerm[0].name, completions, inScope);

        AddKeywordCompletions(initialTerm[0].name, completions);
/*
        for (let file of scriptfiles.GetAllFiles())
        {
            GetScopeCompletions(initialTerm[0].name, file.rootscope, completions);
            for (let subscope of file.rootscope.subscopes) {
                if (subscope.scopetype != scriptfiles.ASScopeType.Function) {
                    continue;
                }
                if (CanCompleteTo(initialTerm[0].name, subscope.funcname)) {
                    completions.push({
                        label: subscope.funcname,
                        detail: subscope.funcreturn + " " + subscope.funcname,
                        kind : SymbolKind.Function,
                    });
                }
            }
        }
*/
    }

    // We are already inside a type, so we need to complete based on that type
    if (initialTerm.length >= 2 && inScope != null)
    {
        GetTermCompletions(initialTerm, inScope, completions);
    }

    // try with implicit namespace
    if (completions.length == 0 && inScope != null)
    {
        let implicitns = true;
        if (initialTerm.length >= 2)
        {
            for (let i = 0; i < initialTerm.length; ++i)
            {
                if (initialTerm[i].type != ASTermType.Namespace)
                    continue;
                implicitns = false;
                break;
            }
        }

        if (implicitns)
        {
            let changed = false;
            let parentscope = inScope;
            while(parentscope)
            {
                if (parentscope.scopetype == scriptfiles.ASScopeType.Namespace)
                {
                    initialTerm.unshift(<ASTerm> {
                        type: ASTermType.Name,
                        name: parentscope.typename,
                    },
                    <ASTerm> {
                        type: ASTermType.Namespace
                    });
                    changed = true;
                }
                parentscope = parentscope.parentscope;
            }

            if (changed)
                GetTermCompletions(initialTerm, inScope, completions);
        }
    }

    // Check if we're inside a function call and complete argument names
    let FuncCall = Signature(params, true);
    if (FuncCall)
    {
        if (FuncCall.activeSignature < FuncCall.signatures.length)
        {
            let signature = FuncCall.signatures[FuncCall.activeSignature];
            for (let arg of signature.parameters)
            {
                completions.push({
                    label: arg.label+" = ",
                    kind: CompletionItemKind.Snippet,
                });
            }
        }
    }

    return completions;
}

export function Resolve(item : CompletionItem) : CompletionItem
{
    if (!item.data)
        return item;

    let type = typedb.GetType(item.data[0]);
    if (type == null)
        return item;

    if (item.data.length == 1)
    {
        //item.detail = type.declaredModule + ".as";
        item.documentation = type.documentation;
        return item;
    }

    let func = type.getMethod(item.data[1]);
    if (func)
    {
        //item.detail = func.declaredModule + ".as";
        item.documentation = func.documentation;
    }
    else
    {
        let prop = type.getProperty(item.data[1]);
        if (prop && prop.documentation) {
            //item.detail = func.declaredModule + ".as";
            item.documentation = prop.documentation;
        }
    }

    return item;
}

export function Signature(params : TextDocumentPositionParams, paramNamesOnly : boolean = false) : SignatureHelp
{
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    let originalPos = pos;
    if (pos < 0)
        return null;

    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;

    // Find the opening bracket in front of our current pos
    let brackets = 0;
    let startOfArg = true;
    while (true)
    {
        let char = file.rootscope.content[pos];
        if (char == ';' || char == '{' || char == '}')
            return null;
        if (char == ')')
            brackets += 1;
        if (char == '(')
        {
            brackets -= 1;
            if(brackets < 0)
                break;
        }
        if (char == ',' && brackets == 0)
            startOfArg = false;
        if (paramNamesOnly && char == '=' && startOfArg)
            return null;

        pos -= 1;
        if(pos < 0)
            return null;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let checkTypes : Array<typedb.DBType>;

    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;

    let sigHelp = <SignatureHelp> {
        signatures : new Array<SignatureInformation>(),
        activeSignature : 0,
        activeParameter : GetActiveParameterCount(originalPos, params.textDocument.uri),
    };
    let foundFunc = false;

    // check for delegate type
    let termType = GetTypeFromTerm(term, 0, term.length, scope, true);
    if (termType && termType.isDelegate && termType.methods.length > 0) {
        let params = new Array<ParameterInformation>();

        for (let arg of termType.methods[0].args)
        {
            params.push(<ParameterInformation>
            {
                label: arg.format()
            });
        }

        let sig = <SignatureInformation> {
            label: termType.methods[0].format(),
            parameters: params,
            documentation: termType.documentation,
        };

        sigHelp.activeSignature = sigHelp.signatures.length;
        sigHelp.signatures.push(sig);
        return sigHelp;
    }

    for (let type of checkTypes)
    {
        if (scope.scopetype == scriptfiles.ASScopeType.Class)
        {
            // Ignore functions from the class if we're in the
            // class' scope. Since we're most likely completing
            // an override function declaration at this point.
            if (type.typename == scope.typename)
            {
                // Switch to the parent type so we can complete overrides for its functions
                type = type.supertype ? typedb.GetType(type.supertype) : null;
                if (!type)
                    continue;
            }
        }

        for (let func of type.allMethods())
        {
            if (func.name != term[term.length-1].name)
                continue;

            let params = new Array<ParameterInformation>();
            if (func.args)
            {
                // Show the active signature for the least amount of arguments
                if (func.args.length > sigHelp.activeParameter && !foundFunc)
                {
                    sigHelp.activeSignature = sigHelp.signatures.length;
                    foundFunc = true;
                }

                for (let arg of func.args)
                {
                    params.push(<ParameterInformation>
                    {
                        label: paramNamesOnly ? arg.name : arg.format()
                    });
                }
            }

            let sig = <SignatureInformation> {
                label: func.format(),
                parameters: params,
                documentation: func.documentation,
            };

            sigHelp.signatures.push(sig);
        }
    }

    // Deal with unified call syntax from global functions
    if(curtype != null && scope != null)
    {
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes)
        {
            for (let func of globaltype.allMethods())
            {
                if (func.name != term[term.length-1].name)
                    continue;
                if(!func.args || func.args.length == 0 || !curtype.inheritsFrom(func.args[0].typename))
                    continue;

                let sig = <SignatureInformation> {
                    label: func.format(null, true),
                    parameters: new Array<ParameterInformation>(),
                    documentation: func.documentation,
                };

                sigHelp.signatures.push(sig);
            }
        }
    }

    return sigHelp.signatures.length == 0 ? null : sigHelp;
}

function GetScopeHover(initialTerm : string, scope : scriptfiles.ASScope) : string | null
{
    if (scope.scopetype != scriptfiles.ASScopeType.Class
        //&& scope.scopetype != scriptfiles.ASScopeType.Global
    )
    {
        for (let scopevar of scope.variables)
        {
            if (scopevar.name == initialTerm)
            {
                let hover = "";
                if(scopevar.documentation)
                {
                    hover += "*";
                    hover += scopevar.documentation.replace("\n","*\n\n*");
                    hover += "*\n\n";
                }

                hover += "```angelscript\n"+scopevar.typename+" "+scopevar.name+"\n```";
                return hover;
            }
        }
    }

    if (scope.parentscope)
        return GetScopeHover(initialTerm, scope.parentscope);
    return null;
}

function AddScopeSymbols(file: scriptfiles.ASFile, scope : scriptfiles.ASScope, symbols: Array<SymbolInformation>)
{
    let scopeSymbol = <SymbolInformation> {
        name : scope.typename,
        location : file.GetLocationRange(scope.startPosInFile, scope.endPosInFile),
    };

    if (scope.scopetype == scriptfiles.ASScopeType.Class)
    {
        scopeSymbol.kind = SymbolKind.Class;
        symbols.push(scopeSymbol);

        for (let classVar of scope.variables)
        {
            if (classVar.isArgument)
                continue;

            symbols.push(<SymbolInformation> {
                name : classVar.name,
                kind : SymbolKind.Variable,
                location : file.GetLocation(classVar.posInFile),
                containerName : scope.typename,
            });
        }
    }
    else if (scope.scopetype == scriptfiles.ASScopeType.Enum)
    {
        scopeSymbol.kind = SymbolKind.Enum;
        symbols.push(scopeSymbol);

        for (let enumVar of scope.variables)
        {
            symbols.push(<SymbolInformation> {
                name : enumVar.name,
                kind : SymbolKind.EnumMember,
                location : file.GetLocation(enumVar.posInFile),
                containerName : scope.typename,
            });
        }
    }
    else if (scope.scopetype == scriptfiles.ASScopeType.Function)
    {
        scopeSymbol.name = scope.funcname+"("+scope.funcargs+")";
        if (scope.parentscope.scopetype == scriptfiles.ASScopeType.Class)
        {
            scopeSymbol.kind = SymbolKind.Method;
            scopeSymbol.containerName = scope.parentscope.typename;
        }
        else
        {
            scopeSymbol.kind = SymbolKind.Function;
        }

        symbols.push(scopeSymbol);
    }

    for (let subscope of scope.subscopes)
    {
        AddScopeSymbols(file, subscope, symbols);
    }
}

export function DocumentSymbols( uri : string ) : SymbolInformation[]
{
    let symbols = new Array<SymbolInformation>();
    let file = scriptfiles.GetFile(uri);
    if (!file)
        return symbols;

    AddScopeSymbols(file, file.rootscope, symbols);

    return symbols;
}

export function WorkspaceSymbols( query : string ) : SymbolInformation[]
{
    let symbols = new Array<SymbolInformation>();

    for ( let file of scriptfiles.GetAllFiles())
    {
        AddScopeSymbols(file, file.rootscope, symbols);
    }

    return symbols;
}

function FormatHoverDocumentation(doc : string) : string
{
    if (doc)
    {
        let outDoc = "*";
        outDoc += doc.replace(/\s*\r?\n\s*/g,"*\n\n*");
        outDoc += "*\n\n";
        return outDoc;
    }
    return "";
}

export function GetHover(params : TextDocumentPositionParams) : Hover
{
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position);
    if (pos < 0)
        return null;

    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;

    // Find the end of the identifier
    while (true)
    {
        let char = file.rootscope.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if(pos >= file.rootscope.content.length)
            break;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);
    let hover = "";

    let implicitns = true;
    if (term.length >= 2)
    {
        for (let i = 0; i < term.length; ++i)
        {
            if (term[i].type != ASTermType.Namespace)
                continue;
            implicitns = false;
            break;
        }
    }

    for (let i = 0; i < 2; ++i)
    {
        let checkTypes : Array<typedb.DBType>;

        if (i != 0)
        {
            // on the second run, prepend the namespace declaration terms and resolve again
            if (!implicitns)
                break;

            let changed = false;
            let parentscope = scope.parentscope;
            while (parentscope)
            {
                if (parentscope.scopetype == scriptfiles.ASScopeType.Namespace)
                {
                    term.unshift(<ASTerm> {
                        type: ASTermType.Name,
                        name: parentscope.typename,
                    },
                    <ASTerm> {
                        type: ASTermType.Namespace
                    });
                    changed = true;
                }
                parentscope = parentscope.parentscope;
            }

            if (!changed)
                break;
        }

        let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
        if (curtype)
            checkTypes = [curtype];
        else if (curtype == null && term.length == 1)
            checkTypes = GetGlobalScopeTypes(scope, true);
        else
            continue;

        hover = "";

        if (term.length == 1 && scope && hover == "")
        {
            hover = GetScopeHover(term[0].name, scope);
            if(hover && hover.length != 0)
                break;
            hover = "";
        }

        let settername = "set_"+term[term.length-1].name;
        let gettername = "get_"+term[term.length-1].name;
        let hadPropertyDoc = false;
        for (let type of checkTypes)
        {
            for (let func of type.allMethods())
            {
                if (func.name != term[term.length-1].name && func.name != gettername && func.name != settername)
                    continue;
                if (func.isConstructor || func.isDestructor)
                    continue;

                let prefix = null;
                if(type.typename.startsWith("__"))
                {
                    if(type.typename != "__")
                        prefix = type.typename.substring(2)+"::";
                }
                else if(!type.typename.startsWith("//"))
                    prefix = type.typename+".";

                hover = "";
                hover += FormatHoverDocumentation(func.documentation);
                if (func.documentation)
                    hadPropertyDoc = true;
                if (func.name == gettername)
                    hover += "```angelscript\n"+func.returnType+" "+prefix+term[term.length-1].name+"\n```";
                else if (func.name == settername && func.args.length >= 1)
                    hover += "```angelscript\n"+func.args[0].typename+" "+prefix+term[term.length-1].name+"\n```";
                else
                    hover += "```angelscript\n"+func.format(prefix)+"\n```";

                if ((func.name == gettername || func.name == settername) && !hadPropertyDoc)
                    continue;
                else
                    break;
            }

            if (hover.length != 0 && hadPropertyDoc)
                break;

            for (let prop of type.allProperties())
            {
                if (prop.name != term[term.length-1].name)
                    continue;

                let prefix = null;
                if(!type.isEnum && type.typename.startsWith("__"))
                {
                    if(type.typename != "__")
                        prefix = type.typename.substring(2)+"::";
                }
                /*else if(!type.typename.startsWith("//"))
                    prefix = type.typename+".";*/

                hover = "";
                hover += FormatHoverDocumentation(prop.documentation);
                hover += "```angelscript\n"+prop.format(prefix)+"\n```";
                if (prop.documentation)
                    hadPropertyDoc = true;
                break;
            }

            if(hover.length != 0)
                break;
        }

        // Deal with unified call syntax from global functions
        if(term.length != 1 && hover == "")
        {
            let ucsScopes = GetGlobalScopeTypes(scope, false, false);
            for (let globaltype of ucsScopes)
            {
                for (let func of globaltype.allMethods())
                {
                    if (func.name != term[term.length-1].name)
                        continue;
                    if (!func.args || func.args.length == 0 || !curtype.inheritsFrom(func.args[0].typename))
                        continue;

                    hover = "";
                    hover += FormatHoverDocumentation(func.documentation);
                    hover += "```angelscript\n"+func.format(null, true)+"\n```";
                }
            }
        }

        if (term.length == 1 && (!hover || hover.length == 0) && term[0].name.length != 0)
        {
            let hoveredType = typedb.GetType(term[0].name);
            if (hoveredType)
            {
                let hover = "";
                hover += FormatHoverDocumentation(hoveredType.documentation);
                hover += "```angelscript\n";
                if (hoveredType.isDelegate)
                {
                    hover += "funcdef ";
                    hover += hoveredType.typename;
                }
                else
                {
                    if (!hoveredType.isPrimitive)
                    {
                        if (hoveredType.isStruct)
                            hover += "struct ";
                        else
                            hover += "class ";
                    }
                    hover += hoveredType.typename;
                    if (hoveredType.supertype)
                        hover += " : "+hoveredType.supertype;
                    else if (hoveredType.unrealsuper)
                        hover += " : "+hoveredType.unrealsuper;
                }

                hover += "\n```";
                return <Hover> {contents: <MarkupContent> {
                    kind: "markdown",
                    value: hover,
                }};
            }

            let nsType = typedb.GetType("__"+term[0].name);
            if (nsType)
            {
                let hover = "";
                hover += FormatHoverDocumentation(nsType.documentation);
                hover += "```angelscript\n";
                nsType.resolveNamespace();
                if (nsType.isEnum)
                    hover += "enum ";
                else
                    hover += "namespace ";
                hover += nsType.rawName;
                hover += "\n```";

                return <Hover> {contents: <MarkupContent> {
                    kind: "markdown",
                    value: hover,
                }};
            }
        }

        if(hover != null && hover.length > 0)
            break;
    }
   
    if (hover == null || hover == "")
        return null;

    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

function ExpandCheckedTypes(checkTypes : Array<typedb.DBType>)
{
    let count = checkTypes.length;
    for (let i = 0; i < count; ++i)
    {
        let checkType = checkTypes[i];
        if (checkType.hasExtendTypes())
        {
            for (let extendType of checkType.getExtendTypes())
            {
                if (!checkTypes.includes(extendType))
                    checkTypes.push(extendType);
            }
        }
    }
}

function GetScopeUnrealType(scope : scriptfiles.ASScope) : string
{
    // First walk upwards until we find the class we're in
    let inClass : string;

    let classscope = scope;
    while(classscope && classscope.scopetype != scriptfiles.ASScopeType.Class)
        classscope = classscope.parentscope;

    if (!classscope)
        return "";
    return GetUnrealTypeFor(classscope.typename);
}

export function GetUnrealTypeFor(typename : string) : string
{
    // Walk through the typedb to find parent types until we find a C++ class
    let type = typedb.GetType(typename);
    while(type && type.declaredModule && type.supertype)
        type = typedb.GetType(type.supertype);

    if (!type)
        return "";

    return type.typename;
}

export function GetCompletionTypeAndMember(params : TextDocumentPositionParams) : Array<string>
{
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos < 0)
        return null;

    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;

    // Find the end of the identifier
    while (true)
    {
        let char = file.rootscope.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if(pos >= file.rootscope.content.length)
            break;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let checkTypes : Array<typedb.DBType>;

    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
    {
        return [curtype.typename, term[term.length-1].name];
    }
    else if(scope)
    {
        return [GetScopeUnrealType(scope), term[term.length-1].name];
    }
    else
    {
        return ["", term[term.length-1].name];
    }
}

export function GetDefinition(params : TextDocumentPositionParams) : Definition
{
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos < 0)
        return null;

    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;

    // Find the end of the identifier
    while (true)
    {
        let char = file.rootscope.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if(pos >= file.rootscope.content.length)
            break;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let implicitns = true;
    if (term.length >= 2)
    {
        for (let i = 0; i < term.length; ++i)
        {
            if (term[i].type != ASTermType.Namespace)
                continue;
            implicitns = false;
            break;
        }
    }

    for (let i = 0; i < 2; ++i)
    {
        let checkTypes : Array<typedb.DBType>;

        if (i != 0)
        {
            // on the second run, prepend the namespace declaration terms and resolve again
            if (!implicitns)
                break;

            let changed = false;
            let parentscope = scope.parentscope;
            while (parentscope)
            {
                if (parentscope.scopetype == scriptfiles.ASScopeType.Namespace)
                {
                    term.unshift(<ASTerm> {
                        type: ASTermType.Name,
                        name: parentscope.typename,
                    },
                    <ASTerm> {
                        type: ASTermType.Namespace
                    });
                    changed = true;
                }
                parentscope = parentscope.parentscope;
            }

            if (!changed)
                break;
        }

        let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
        if (curtype)
            checkTypes = [curtype];
        else if (curtype == null && term.length == 1)
            checkTypes = GetGlobalScopeTypes(scope, true);
        else
            continue;

        ExpandCheckedTypes(checkTypes);

        let locations : Array<Location> = [];

        for (let type of checkTypes)
        {
            if (!type.declaredModule)
                continue;

            let loc = scriptfiles.GetSymbolLocation(type.declaredModule, type.typename, term[term.length-1].name);
            if (loc)
                locations.push(loc);
        }

        if (term.length == 1 && scope)
        {
            // We could be trying to go to something declared as a variable right inside the scope we're in
            let loc = scriptfiles.GetSymbolLocationInScope(scope, term[0].name);
            if (loc)
                locations.push(loc);

            // We could be trying to go to a type, rather than a variable or function
            let dbtype = typedb.GetType(term[0].name);
            if(!dbtype)
                dbtype = typedb.GetType("__"+term[0].name);

            if (dbtype && dbtype.declaredModule)
            {
                let loc = scriptfiles.GetTypeSymbolLocation(dbtype.declaredModule, dbtype.typename);
                if (loc)
                    locations.push(loc);
            }

            // We could be trying to get a global symbol for any of the many global scopes
            if (locations.length == 0)
            {
                for(let [typename, dbtype] of typedb.database)
                {
                    if (!typename.startsWith("//"))
                        continue;
                    if (!dbtype.declaredModule)
                        continue;

                    let loc = scriptfiles.GetSymbolLocation(dbtype.declaredModule, null, term[0].name);
                    if (loc)
                        locations.push(loc);
                }
            }

        }

        if (term.length >= 1 && scope)
        {
            // We could be trying to get a ucs called global function that's in-scope
            let ucsScopes = GetGlobalScopeTypes(scope, false, false);
            for (let globaltype of ucsScopes)
            {
                let func = globaltype.getMethod(term[term.length-1].name);
                if(!func)
                    continue;

                let loc = scriptfiles.GetSymbolLocation(func.declaredModule, null, func.name);
                if (loc)
                    locations.push(loc);
            }

            // We could by trying to get a ucs called global function in any global scope
            if (locations.length == 0)
            {
                for(let [typename, dbtype] of typedb.database)
                {
                    if (!typename.startsWith("//"))
                        continue;
                    if (!dbtype.declaredModule)
                        continue;

                    let loc = scriptfiles.GetSymbolLocation(dbtype.declaredModule, checkTypes.length == 1 ? checkTypes[0].typename : null, term[term.length-1].name);
                    if (loc)
                        locations.push(loc);
                }
            }
        }

        if (locations && locations.length != 0)
            return locations;
    }

    return null;
}

let re_literal_float = /^-?[0-9]+\.[0-9]*f$/;
let re_literal_int = /^-?[0-9]+$/;
let re_auto_decl = /^auto\s*@?$/;

export function ResolveAutos(root : scriptfiles.ASScope)
{
    let re_handles = /^[@\s]+/;

    for (let vardesc of root.variables)
    {
        if (!vardesc.typename.startsWith("auto"))
            continue;
        if (!re_auto_decl.test(vardesc.typename))
            continue;
        if (!vardesc.expression)
            continue;

        let isHandle = vardesc.typename.endsWith("@");
        let decl = vardesc.expression;
        decl = decl.replace(re_handles, "");

        let terms = ParseTerms(decl);

        let implicitns = true;
        if (terms.length >= 2)
        {
            for (let i = 0; i < terms.length; ++i)
            {
                if (terms[i].type != ASTermType.Namespace)
                    continue;
                implicitns = false;
                break;
            }
        }

        let resolvedType : typedb.DBType;
        for (let i = 0; i < 2; ++i)
        {
            if (i != 0)
            {
                // on the second run, prepend the namespace declaration terms and resolve again
                if (!implicitns)
                    break;

                let changed = false;
                let parentscope = root;
                while (parentscope)
                {
                    if (parentscope.scopetype == scriptfiles.ASScopeType.Namespace)
                    {
                        terms.unshift(<ASTerm> {
                            type: ASTermType.Name,
                            name: parentscope.typename,
                        },
                        <ASTerm> {
                            type: ASTermType.Namespace
                        });
                        changed = true;
                    }
                    parentscope = parentscope.parentscope;
                }

                if (!changed)
                    break;
            }

            resolvedType = GetTypeFromTerm(terms, 0, terms.length, root, true);
            if(resolvedType)
            {
                vardesc.typename = resolvedType.typename;
                break;
            }
        }

        // Parse basic literal types
        if (!resolvedType)
        {
            if (terms.length == 1)
            {
                let literalExpr = terms[0].name.trim();
                if (literalExpr.endsWith("\""))
                {
                    if (literalExpr.startsWith("\""))
                    {
                        vardesc.typename = "String";
                    }
                }
                else if (re_literal_int.test(literalExpr))
                {
                    vardesc.typename = "int";
                }
            }
            else if (terms.length == 3)
            {
                if (terms[1].type == ASTermType.PropertyAccess)
                {
                    if (re_literal_float.test(terms[0].name + "." + terms[2].name))
                    {
                        vardesc.typename = "float";
                    }
                }
            }
        }

        if (isHandle && !vardesc.typename.endsWith("@"))
        {
            vardesc.typename += "@";
        }
    }

    for (let subscope of root.subscopes)
    {
        ResolveAutos(subscope);
    }
}

function GetActiveParameterCount(pos : number, uri : string) : number
{
    let file = scriptfiles.GetFile(uri);
    if (file == null)
        return null;

    let paramCount = 0;

    let termstart = pos;
    let brackets = 0;
    while (termstart > 0)
    {
        let char = file.rootscope.content[termstart];
        let end = false;

        switch(char)
        {
            case ';':
            case '{':
            case '}':
                end = true; break;

            case '(':
                if(brackets > 0)
                    brackets -= 1;
                else end = true;
            break;

            case ')':
                brackets += 1;
            break;

            case ',':
                if (brackets == 0)
                    paramCount += 1;
            break;
        }

        if(end)
            break;
        termstart -= 1;
    }

    return paramCount;
}