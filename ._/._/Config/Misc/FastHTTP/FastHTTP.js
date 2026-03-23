import SyAPP from '../../../../SyAPP.js'
import HTTPClient from "../../../._/Util/HTTPClient.js"
import SyDB from '../../../../SyDB.js'
import Route from './entities/Route.js'
import Group from './entities/Group.js'

class FastHTTP extends SyAPP.Func() {
    constructor(){
        super(
            'fasthttp',
            async (props) => {
                let uid = props.session.UniqueID

                if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}
                //if(have && previous!=actual){refresh}

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
                        }

                        if(props.renameroute){ this.WaitInput(uid,{props : {newroutename : true}}) }

                        if(props.editurl){ this.WaitInput(uid,{props : {newurl : true}})  }
                        

                        this.Text(uid,' ')
                        this.Text(uid,`${route.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(route.Method)} | ${this.TextColor.cyan(route.Url)}`)
                        this.Button(uid,this.TextColor.pink('Run'))
                        this.Button(uid,'Rename',{props : {renameroute : true}})
                        this.Button(uid,'Edit URL',{props : {editurl : true}})
                        await this.DropDown(uid,'changemethod',async () => {
                            let methods = ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS']
                            methods.forEach(e => {
                                this.Button(uid,HTTPClient.colorHttpMethod(e),{props : {changemethod : e}})
                            })
                        },{up_buttontext : `Change Method | ${HTTPClient.colorHttpMethod(route.Method)}`,down_buttontext : 'Change Method',horizontal : true})
                        await this.DropDown(uid,'editbody',async () => {
                            this.Button(uid,'')
                        })
                        
                        this.Button(uid,' ')
                        this.Button(uid,'<- Return',{props : {exitedit : true}})

                    } else {

                        if(props.newroute){
                            await Route.New('New Route')
                        }
    
                        if(props.removeroute){
                            await Route.Model.delete(props.removeroute)
                        }
    
                        let routes = await Route.Model.find()
    
                        for (const [index, route] of routes.entries()) {
                            await this.DropDown(uid,route._id,async () => {
                                this.Buttons(uid,[
                                    {name : 'Run'},
                                    {name : 'Edit',props : {editroute : route._id}},
                                    {name : 'Remove',props : {removeroute : route._id}}
                                ])
                            },{up_buttontext : `${route.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(route.Method)} | ${this.TextColor.cyan(route.Url)}`,down_buttontext : `${route.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(route.Method)} | ${this.TextColor.cyan(route.Url)}`})
                          }
    
                       this.Button(uid,' ')
                       this.Button(uid,'+ New',{props : {newroute : true}})


                    }

                    

                })


                await this.Page(uid,'env',async () => {

                  this.Button(uid,'teste1')


                })


                await this.Page(uid,'globalvar',async () => {

                    this.Button(uid,'teste2')


                })



        


                this.Button(uid,this.TextColor.blue('――――――――――――――――――――――――――――――――――――――――――――――'))
                this.Buttons(uid,[
                    {name : (props.page == '' || !props.page) ? this.TextColor.yellow('Home') : 'Home' ,props : {page : ''}},
                    {name : (props.page == 'env') ? this.TextColor.yellow('Env') : 'Env' ,props : {page : 'env'}},
                    {name : (props.page == 'globalvar') ? this.TextColor.yellow('Global Variables') : 'Global Variables'  ,props : {page : 'globalvar'}},
                    {name :'<- Return',path : this.Storages.Get(uid,'parentfunc')}
                ])
            })
        }
    }

export default FastHTTP