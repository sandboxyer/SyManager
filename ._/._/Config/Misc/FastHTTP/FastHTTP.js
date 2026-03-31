import SyAPP from '../../../../SyAPP.js'
import HTTPClient from "../../../._/Util/HTTPClient.js"
import SyDB from '../../../../SyDB.js'
import Route from './entities/Route.js'
import Group from './entities/Group.js'
import BodyKey from './entities/BodyKey.js'
import Component from './entities/Component.js'
import Variable from './entities/Variable.js'

function parseHttpRequest(requestString) {
    const [method, route] = requestString.trim().split(' ');
    return {
        Method: method.toUpperCase(),
        Route: route
    };
}

function formatStatusWithColor(statusCode) {
    // Define color codes
    const colors = {
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        red: '\x1b[31m',
        reset: '\x1b[0m'
    };
    
    let color;
    
    if (statusCode >= 200 && statusCode < 300) {
        color = colors.green;      // 2xx - Success
    } else if (statusCode >= 300 && statusCode < 400) {
        color = colors.yellow;     // 3xx - Redirection
    } else if (statusCode >= 400 && statusCode < 600) {
        color = colors.red;        // 4xx/5xx - Client/Server errors
    } else {
        color = colors.reset;      // Unknown status codes
    }
    
    return `${color}${statusCode}${colors.reset}`;
}

class FastHTTP extends SyAPP.Func() {
    constructor(){
        super(
            'fasthttp',
            async (props) => {
                let uid = props.session.UniqueID

                if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}
                //if(have && previous!=actual){refresh}

                let formatData = (data, uid, maxDepth = 0, currentDepth = 0) => {
                    const indent = '  '.repeat(currentDepth);
                    const textFunc = this.Text.bind(this);
                    
                    // Safe text output function with fallback
                    const safeText = (uid, text) => {
                        try {
                            if (this.Text && typeof this.Text === 'function') {
                                this.Text(uid, text);
                            } else if (textFunc) {
                                textFunc(uid, text);
                            } else {
                                console.log(text);
                            }
                        } catch (err) {
                            console.log(text);
                        }
                    };
                    
                    // Safe color function
                    const colorText = (text) => {
                        try {
                            if (this.TextColor && this.TextColor.gold && typeof this.TextColor.gold === 'function') {
                                return this.TextColor.gold(text);
                            }
                            return text;
                        } catch (err) {
                            return text;
                        }
                    };
                    
                    // Helper function to format primitive value
                    const formatPrimitive = (value) => {
                        if (value === null) return 'null';
                        if (typeof value === 'boolean') return value.toString();
                        if (typeof value === 'number') return value.toString();
                        if (typeof value === 'string') return `'${value}'`;
                        return `'${value}'`;
                    };
                    
                    // Helper function to check if array contains only primitives
                    const isPrimitiveArray = (arr) => {
                        return arr.every(item => 
                            item === null || 
                            typeof item === 'string' || 
                            typeof item === 'number' || 
                            typeof item === 'boolean'
                        );
                    };
                    
                    // Handle null/undefined
                    if (data === null || data === undefined) {
                        safeText(uid, `${indent}null`);
                        return;
                    }
                    
                    // Handle arrays
                    if (Array.isArray(data)) {
                        // Check if we've reached max depth
                        if (maxDepth > 0 && currentDepth >= maxDepth) {
                            safeText(uid, `${indent}[array]`);
                            return;
                        }
                        
                        if (data.length === 0) {
                            safeText(uid, `${indent}[]`);
                            return;
                        }
                        
                        // Check if array contains only primitives and we're not at the first level of object property
                        if (isPrimitiveArray(data) && currentDepth > 0) {
                            // Compact format for primitive arrays
                            const formattedValues = data.map(item => formatPrimitive(item)).join(', ');
                            safeText(uid, `${indent}[${formattedValues}]`);
                            return;
                        }
                        
                        // Multi-line format for arrays with objects or nested arrays
                        safeText(uid, `${indent}[`);
                        data.forEach((item, index) => {
                            if (index > 0) safeText(uid, `, `);
                            formatData(item, uid, maxDepth, currentDepth + 1);
                        });
                        safeText(uid, `]`);
                        return;
                    }
                    
                    // Handle objects
                    if (typeof data === 'object') {
                        // Check if we've reached max depth
                        if (maxDepth > 0 && currentDepth >= maxDepth) {
                            safeText(uid, `${indent}[object]`);
                            return;
                        }
                        
                        const result_keys = Object.keys(data);
                        if (result_keys.length === 0) {
                            safeText(uid, `${indent}{}`);
                            return;
                        }
                        
                        safeText(uid, `${indent}{`);
                        result_keys.forEach((key, index) => {
                            const value = data[key];
                            const valueType = typeof value;
                            const lineIndent = `${indent}  `;
                            const isLast = index === result_keys.length - 1;
                            
                            try {
                                if (value === null) {
                                    safeText(uid, `\n${lineIndent}${key} : null${isLast ? '' : ','}`);
                                } else if (Array.isArray(value)) {
                                    // Check if next level would exceed max depth
                                    if (maxDepth > 0 && currentDepth + 1 >= maxDepth) {
                                        safeText(uid, `\n${lineIndent}${key} : ${colorText('[array]')}${isLast ? '' : ','}`);
                                    } else {
                                        // Check if it's a primitive array for compact display
                                        if (isPrimitiveArray(value) && currentDepth + 1 > 0) {
                                            const formattedValues = value.map(item => formatPrimitive(item)).join(', ');
                                            safeText(uid, `\n${lineIndent}${key} : ${colorText(`[${formattedValues}]`)}${isLast ? '' : ','}`);
                                        } else {
                                            safeText(uid, `\n${lineIndent}${key} : `);
                                            formatData(value, uid, maxDepth, currentDepth + 1);
                                            if (!isLast) safeText(uid, `,`);
                                        }
                                    }
                                } else if (valueType === 'object') {
                                    // Check if next level would exceed max depth
                                    if (maxDepth > 0 && currentDepth + 1 >= maxDepth) {
                                        safeText(uid, `\n${lineIndent}${key} : ${colorText('[object]')}${isLast ? '' : ','}`);
                                    } else {
                                        safeText(uid, `\n${lineIndent}${key} : `);
                                        formatData(value, uid, maxDepth, currentDepth + 1);
                                        if (!isLast) safeText(uid, `,`);
                                    }
                                } else if (valueType === 'boolean') {
                                    safeText(uid, `\n${lineIndent}${key} : ${colorText(value.toString())}${isLast ? '' : ','}`);
                                } else if (valueType === 'number') {
                                    safeText(uid, `\n${lineIndent}${key} : ${colorText(value.toString())}${isLast ? '' : ','}`);
                                } else if (valueType === 'string') {
                                    safeText(uid, `\n${lineIndent}${key} : ${colorText(`'${value}'`)}${isLast ? '' : ','}`);
                                } else {
                                    safeText(uid, `\n${lineIndent}${key} : ${colorText(`'${value}'`)}${isLast ? '' : ','}`);
                                }
                            } catch (err) {
                                safeText(uid, `\n${lineIndent}${key} : ${colorText('[error]')}${isLast ? '' : ','}`);
                            }
                        });
                        safeText(uid, `\n${indent}}`);
                        return;
                    }
                    
                    // Handle primitive values for array items
                    try {
                        if (typeof data === 'boolean') {
                            safeText(uid, `${colorText(data.toString())}`);
                        } else if (typeof data === 'number') {
                            safeText(uid, `${colorText(data.toString())}`);
                        } else {
                            safeText(uid, `${colorText(`'${data}'`)}`);
                        }
                    } catch (err) {
                        safeText(uid, `${colorText('[error]')}`);
                    }
                };

                const CloseDropdown = (name) => {
                    const storageKey = `dropdown-${name}`;
                    if (this.Storages.Has(uid, storageKey)) {
                      const state = this.Storages.Get(uid, storageKey);
                      if (state && state.dropped) {
                        state.dropped = false;
                        this.Storages.Set(uid, storageKey, state);
                        return true;
                      }
                    }
                    return false;
                  };

                let NewDropDown = async (ownerid) => {

                }

                this.Text(uid,'FastHTTP')

                if(props.requestcreatebody){
                    let creation_count = 0
                    let keys = await BodyKey.Model.find()
                    for(const key of props.requestcreatebody){
                        let have = false
                        keys.forEach(e => {
                            if(e.Key == key && e.RouteID == props.crouteid){
                                have = true
                            }
                        })
                        if(!have){
                            await BodyKey.Model.create({RouteID : props.crouteid,Key : key,Value : 'blank value'})
                            creation_count++
                        }
                    }
                    if(creation_count > 0 ){
                        this.Text(uid,' ')
                        this.Text(uid,this.TextColor.green('Body Keys created !'))
                    } else {
                        this.Text(uid,' ')
                        this.Text(uid,this.TextColor.red('Error or Keys exist'))
                    }
                }

                await this.Page(uid,'',async () => {

                    if(props.editroute){this.Storages.Set(uid,'editroute',props.editroute)}

                    if(props.exitedit){this.Storages.Delete(uid,'editroute')}

                    if(this.Storages.Has(uid,'editroute')){

                        let route = await Route.Model.findById(this.Storages.Get(uid,'editroute'))

                        if(props.changemethod){
                            await route.update({Method : props.changemethod})
                            CloseDropdown('changemethod')
                        }

                        if(props.inputValue){
                            if(props.newroutename){
                                await route.update({Name : props.inputValue})
                            }
                            if(props.newurl){
                                await route.update({Url : props.inputValue})
                            }

                            if(props.newkeyvalue_key){

                                this.Storages.Delete(uid,'keyvalue')
                                this.Storages.Set(uid,'keyvalue',props.inputValue)
                                this.WaitInput(uid,{question : 'Key value : ',props : {newkeyvalue_value: true}})
                            }

                            if(props.newkeyvalue_value){
                               await BodyKey.Model.create({RouteID : route._id,Key : this.Storages.Get(uid,'keyvalue'),Value : props.inputValue})
                            }

                            if(props.inputchangebodykey){
                                await BodyKey.Model.update(this.Storages.Get(uid,'editbodykey'),{Value : props.inputValue})
                                this.Storages.Delete(uid,'editbodykey')
                            }
                        }

                        if(props.newkeyvalue){ this.WaitInput(uid,{question : 'Key name : ',props : {newkeyvalue_key: true}}) }

                        if(props.renameroute){ this.WaitInput(uid,{props : {newroutename : true}}) }

                        if(props.editurl){ this.WaitInput(uid,{props : {newurl : true}})  }

                        if(props.editbodykey){
                            this.Storages.Set(uid,'editbodykey',props.editbodykey)
                        }

                        if(props.removebodykey){
                           await BodyKey.Model.delete(this.Storages.Get(uid,'editbodykey'))
                           this.Storages.Delete(uid,'editbodykey')
                        }

                        if(props.changebodykey){
                            this.WaitInput(uid,{props : {inputchangebodykey :  this.Storages.Get(uid,'editbodykey')}})
                        }

                        this.Text(uid,' ')
                        this.Text(uid,`${route.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(route.Method)} | ${this.TextColor.cyan(route.Url)}`)
                        

                        if(props.resetreqdata){
                            this.Storages.Delete(uid,'request_data')
                            this.Storages.Delete(uid,'request_data_status')
                        }

                        if(props.requestaddroutes){
                            let group = await Group.New()
                            for(const routestring of this.Storages.Get(uid,'request_data').available){
                                let reqobj = parseHttpRequest(routestring)
                                await Route.New({Method : reqobj.Method,Url : `http://localhost:3000${reqobj.Route}`,GroupID : group.id})
                            }
                            this.Text(uid,' ')
                            this.Text(uid,this.TextColor.green('Group with routes created !'))
                            
                        }

                        if(props.runroute){
                            props.runroute = route._id
                            //let route = await Route.Model.findById(props.runroute)
                            if(route._id){
                                if(route.Method.toLocaleLowerCase() == 'post'){
                                    let keys = await BodyKey.Model.find({RouteID : route._id})
                                    let body = {}
                                    keys.forEach(e => {
                                        body[e.Key] = e.Value
                                    })
                                let result = await HTTPClient.post(route.Url,body).catch(e =>{return e})
                                if(result.statusCode){
                                    this.Storages.Set(uid,'request_data_routeid',route._id)
                                    this.Storages.Set(uid,'request_data_status',result.statusCode)
                                    if(typeof result.data == 'object'){
                                       
                                        this.Storages.Set(uid,'request_data',result.data)
                                    }
                                    
                                } else {
                                    this.Text(uid,this.TextColor.red(result))
                                }
                                 
                                } else if(route.Method.toLocaleLowerCase() == 'get'){
                                    let keys = await BodyKey.Model.find({RouteID : route._id})
                                    let body = {}
                                    keys.forEach(e => {
                                        body[e.Key] = e.Value
                                    })
                                let result = await HTTPClient.get(route.Url).catch(e =>{return e})
                                if(result.statusCode){
                                    this.Storages.Set(uid,'request_data_routeid',route._id)
                                    this.Storages.Set(uid,'request_data_status',result.statusCode)
                                    if(typeof result.data == 'object'){
                                        this.Storages.Set(uid,'request_data',result.data)
                                    }
                                } else {
                                    this.Text(uid,this.TextColor.red(result))
                                }
                                 
                                } else {
                                    this.Text(uid,this.TextColor.yellow('Method not configured'))
                                }
                            }
                        }

                        if(this.Storages.Has(uid,'request_data') || this.Storages.Has(uid,'request_data_status')){
                            this.Text(uid,' ')
                            this.Text(uid,this.TextColor.red(`―――――――――――――――― ${this.TextColor.white('Status : ')}${formatStatusWithColor(this.Storages.Get(uid,'request_data_status'))}${this.TextColor.red(' ――――――――――――――――')}`))
                            let addroutes = false
                            let addbody = false
                            if(this.Storages.Get(uid,'request_data').error && this.Storages.Get(uid,'request_data').error == 'Route not found'){
                                if(this.Storages.Get(uid,'request_data').available && this.Storages.Get(uid,'request_data').available.length > 0){
                                    addroutes = true
                                }
                            }
                            
                                if(this.Storages.Get(uid,'request_data').missingKeys && this.Storages.Get(uid,'request_data').missingKeys.length > 0){
                                    addbody = true
                                }
                            
                            formatData(this.Storages.Get(uid,'request_data'),uid)
                            this.Buttons(uid,[
                            {name : 'Save'},
                            {name : 'Reset',props : {resetreqdata : true}},
                            {name : 'Navigate'},
                            ...(addroutes ? [{name : this.TextColor.gold('Add Routes'),props : {requestaddroutes : true}}] : []),
                            ...(addbody ? [{name : this.TextColor.gold('Create Body'),props : {crouteid : route._id,requestcreatebody : this.Storages.Get(uid,'request_data').missingKeys}}] : [])
                            ])
                            this.Button(uid,this.TextColor.red('――――――――――――――――――――――――――――――――――――――――――――――'))

                        }

                        
                        this.Button(uid,this.TextColor.pink('Run'),{props : {runroute : true}})
                        this.Button(uid,'Rename',{props : {renameroute : true}})
                        this.Button(uid,'Edit URL',{props : {editurl : true}})
                        await this.DropDown(uid,'changemethod',async () => {
                            let methods = ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS']
                            methods.forEach(e => {
                                this.Button(uid,HTTPClient.colorHttpMethod(e),{props : {changemethod : e}})
                            })
                        },{up_buttontext : `Change Method | ${HTTPClient.colorHttpMethod(route.Method)}`,down_buttontext : 'Change Method',horizontal : true})
                        await this.DropDown(uid,'editbody',async () => {
                            this.Button(uid,' ')
                                let keys = await BodyKey.Model.find({RouteID : route._id})
                                if(keys.length){this.Button(uid,this.TextColor.white('{'))}
                                keys.forEach((e,i) => {
                                    if(i == keys.length-1){
                                        if(this.Storages.Has(uid,'editbodykey') && this.Storages.Get(uid,'editbodykey') == e._id){
                                            this.Button(uid,this.TextColor.bgRed(`${e.Key} : ${e.Value}`),{props : {editbodykey : e._id},jumpTo : keys.length-i+2})
                                        } else {
                                            this.Button(uid,`${this.TextColor.white(e.Key)} : ${this.TextColor.gold(`'${e.Value}'`)}`,{props : {editbodykey : e._id},jumpTo : keys.length-i+2})
                                        }
                                        
                                    } else {
                                        if(this.Storages.Has(uid,'editbodykey') && this.Storages.Get(uid,'editbodykey') == e._id){
                                            this.Button(uid,this.TextColor.bgRed(`${e.Key} : ${e.Value},`),{props : {editbodykey : e._id},jumpTo : keys.length-i+2})
                                        } else {
                                            this.Button(uid,`${this.TextColor.white(e.Key)} : ${this.TextColor.gold(`'${e.Value}'`)}${this.TextColor.white(',')}`,{props : {editbodykey : e._id},jumpTo : keys.length-i+2})
                                        }
                                    }
                                   
                                })
                                if(keys.length){this.Button(uid,this.TextColor.white('}'))}
                                if(this.Storages.Has(uid,'editbodykey')){

                                    this.Button(uid,' ')
                                    this.Buttons(uid,[
                                     {name : 'Edit',props : {changebodykey :  this.Storages.Get(uid,'editbodykey')}},
                                     {name : 'Remove',props : {removebodykey : this.Storages.Get(uid,'editbodykey')}}
                                    ])
                                    this.Button(uid,' ')

                                 }
                                this.Button(uid,' ')
                            this.Button(uid,`+ New ${this.TextColor.gold('key:value')}`,{props : {newkeyvalue : true}})
                        },{up_buttontext : 'Edit body',down_buttontext : 'Edit body'})
                        
                        this.Button(uid,' ')
                        this.Button(uid,'<- Return',{props : {exitedit : true}})

                    } else {

                        if(props.inputValue){
                            if(props.groupnewname){
                                await Component.Model.update(props.groupnewname,{Name : props.inputValue})
                            }
                        }

                        if(props.newroutechild){
                            await Route.New({GroupID : props.newroutechild})
                        }

                        if(props.newroute){
                            await Route.New()
                            CloseDropdown('mainlayernew')
                        }
                        
                        if(props.newgroup){
                            await Group.New()
                            CloseDropdown('mainlayernew')
                        }
    
                        if(props.removeroute){
                            await Route.Model.delete(props.removeroute)
                        }

                        

                        if(props.renamegroup){
                            this.WaitInput(uid,{question : 'New group name : ',props : {groupnewname : props.renamegroup}})
                        }

                        if(props.deletegroup){
                            await Component.Model.delete(props.deletegroup)
                        }

                        if(props.runroute){
                            let route = await Route.Model.findById(props.runroute)
                            if(route._id){
                                if(route.Method.toLocaleLowerCase() == 'post'){
                                    let keys = await BodyKey.Model.find({RouteID : route._id})
                                    let body = {}
                                    keys.forEach(e => {
                                        body[e.Key] = e.Value
                                    })
                                let result = await HTTPClient.post(route.Url,body).catch(e =>{return e})
                                if(result.statusCode){
                                    this.Storages.Set(uid,'request_data_status',result.statusCode)
                                    this.Storages.Set(uid,'request_data_routeid',route._id)
                                    if(typeof result.data == 'object'){
                                        this.Storages.Set(uid,'request_data',result.data)
                                    }
                                    
                                } else {
                                    this.Text(uid,this.TextColor.red(result))
                                }
                                 
                                } else if(route.Method.toLocaleLowerCase() == 'get'){
                                    let keys = await BodyKey.Model.find({RouteID : route._id})
                                    let body = {}
                                    keys.forEach(e => {
                                        body[e.Key] = e.Value
                                    })
                                let result = await HTTPClient.get(route.Url).catch(e =>{return e})
                                if(result.statusCode){
                                    this.Storages.Set(uid,'request_data_status',result.statusCode)
                                    this.Storages.Set(uid,'request_data_routeid',route._id)
                                    if(typeof result.data == 'object'){
                                       
                                        this.Storages.Set(uid,'request_data',result.data)
                                    }
                                } else {
                                    this.Text(uid,this.TextColor.red(result))
                                }
                                 
                                } else {
                                    this.Text(uid,this.TextColor.yellow('Method not configured'))
                                }
                            }
                        }

                        if(props.resetreqdata){
                            this.Storages.Delete(uid,'request_data')
                            this.Storages.Delete(uid,'request_data_status')
                        }

                        if(props.requestaddroutes){
                            let group = await Group.New()
                            for(const routestring of this.Storages.Get(uid,'request_data').available){
                                let reqobj = parseHttpRequest(routestring)
                                await Route.New({Method : reqobj.Method,Url : `http://localhost:3000${reqobj.Route}`,GroupID : group.id})
                            }
                        }

                        if(this.Storages.Has(uid,'request_data') || this.Storages.Has(uid,'request_data_status')){
                            this.Text(uid,this.TextColor.red(`―――――――――――――――― ${this.TextColor.white('Status : ')}${formatStatusWithColor(this.Storages.Get(uid,'request_data_status'))}${this.TextColor.red(' ――――――――――――――――')}`))
                            let addroutes = false
                            let addbody = false
                            if(this.Storages.Get(uid,'request_data').error && this.Storages.Get(uid,'request_data').error == 'Route not found'){
                                if(this.Storages.Get(uid,'request_data').available && this.Storages.Get(uid,'request_data').available.length > 0){
                                    addroutes = true
                                }
                            }

                            if(this.Storages.Get(uid,'request_data').missingKeys && this.Storages.Get(uid,'request_data').missingKeys.length > 0){
                                addbody = true
                            }

                            formatData(this.Storages.Get(uid,'request_data'),uid)
                            this.Buttons(uid,[
                            {name : 'Save'},
                            {name : 'Reset',props : {resetreqdata : true}},
                            {name : 'Navigate'},
                            ...(addroutes ? [{name : this.TextColor.gold('Add Routes'),props : {requestaddroutes : true}}] : []),
                            ...(addbody ? [{name : this.TextColor.gold('Create Body'),props : {crouteid : this.Storages.Get(uid,'request_data_routeid'),requestcreatebody : this.Storages.Get(uid,'request_data').missingKeys}}] : [])
                            ])
                            this.Button(uid,this.TextColor.red('――――――――――――――――――――――――――――――――――――――――――――――'))

                        }
    
                        let components = await Component.Model.find()

                        components = components.filter(e => !e.GroupID)
    
                        for (const [index, component] of components.entries()) {
                            if(component.Type == 'route'){
                                await this.DropDown(uid,component._id,async () => {
                                    this.Buttons(uid,[
                                        {name : 'Run',props : {runroute : component._id}},
                                        {name : 'Edit',props : {editroute : component._id}},
                                        {name : 'Remove',props : {removeroute : component._id}}
                                    ])
                                },{up_buttontext : `${component.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(component.Method)} | ${this.TextColor.cyan(component.Url)}`,down_buttontext : `${component.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(component.Method)} | ${this.TextColor.cyan(component.Url)}`})
                             
                            } else {
                                let all = await Component.Model.find()
                                let childs = []
                                all.forEach(e => {if(e.GroupID == component._id){childs.push(e)}})
                                await this.DropDown(uid,component._id,async () => {
                                    for (const [index, child] of childs.entries()) {
                                        await this.DropDown(uid,child._id,async () => {
                                            this.Buttons(uid,[
                                                {name : 'Run',props : {runroute : child._id}},
                                                {name : 'Edit',props : {editroute : child._id}},
                                                {name : 'Remove',props : {removeroute : child._id}}
                                            ])
                                            if(index == childs.length-1){this.Button(uid,' ')}
                                        },{up_buttontext : `${child.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(child.Method)} | ${this.TextColor.cyan(child.Url)}`,down_buttontext : `${child.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(child.Method)} | ${this.TextColor.cyan(child.Url)}`})
                                    }
                                    
                                    this.Buttons(uid,[
                                        {name : this.TextColor.rgb('  + New',0,255,0),props : {newroutechild : component._id}},
                                        {name : 'Rename group',props : {renamegroup : component._id}},
                                        {name : 'Delete group',props : {deletegroup : component._id}}
                                    ])
                                },{up_buttontext : `${component.Name} (${childs.length})`,down_buttontext : `${component.Name} (${childs.length})`})
                            }
                            }
    
                       this.Button(uid,' ')
                       await this.DropDown(uid,'mainlayernew',async () => {
                        this.Buttons(uid,[
                            {name : 'Route',props : {newroute : true}},
                            {name : 'Group',props : {newgroup : true}}
                        ])
                       },{up_buttontext : this.TextColor.rgb('+ New',0,255,0),down_buttontext : this.TextColor.rgb('New',0,255,0),up_emoji : ''})
                      


                    }

                    

                })


                await this.Page(uid,'settings',async () => {

                if(props.inputValue){
                    if(props.newvariablevalue){
                        await Variable.Model.update(uid,{Value : props.inputValue})
                    }

                    if(props.newvariablevalue){
                        this.WaitInput(uid,{question : 'Value : ',props : {page : 'settings',newvariablefinish : true,keyvalue : props.inputValue}})
                    }

                    if(props.newvariablefinish){
                        await Variable.Model.create({Key : props.keyvalue,Value : props.inputValue})
                    }
    
                }

                if(props.editvariable){
                    this.WaitInput(uid,{question : 'New Value : ',props : {page : 'settings',newvariablevalue : props.editvariable}})
                }

                if(props.removevariable){
                    await Variable.Model.delete(props.removevariable)
                }

                if(props.newvariable){
                    this.WaitInput(uid,{question : 'Key : ',props : {page : 'settings',newvariablevalue : true}})
                }

                

                  this.Button(uid,'Auto save')
                  await this.DropDown(uid,'variables',async () => {
                    let variables = await Variable.Model.find()
                    for(const variable of variables){
                        await this.DropDown(uid,variable._id,async () => {
                            this.Buttons(uid,[
                                {name : 'Edit',props : {editvariable : variable._id}},
                                {name : 'Remove',props : {removevariable : variable._id}}
                            ])
                        },{up_buttontext : `${variable.Key}:${variable.Value}`,down_buttontext : `${variable.Key}:${variable.Value}`})
                    }
                    this.Button(uid,{name : '+ New',props : {newvariable : true}})
                  },{up_buttontext : 'Variables',down_buttontext : 'Variables'})
                  this.Button(uid,'Search APIs')


                })





        


                this.Button(uid,this.TextColor.blue('――――――――――――――――――――――――――――――――――――――――――――――'))
                this.Buttons(uid,[
                    {name : (props.page == '' || !props.page) ? this.TextColor.yellow('Home') : 'Home' ,props : {page : ''}},
                    {name : (props.page == 'settings') ? this.TextColor.yellow('Settings') : 'Settings' ,props : {page : 'settings'}},
                    {name :'<- Return',path : this.Storages.Get(uid,'parentfunc')}
                ])
            })
        }
    }

export default FastHTTP