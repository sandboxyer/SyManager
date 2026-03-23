import SyDB from '../../../../../SyDB.js'

class Component {
    
    static Model = SyDB.Model('Components',{
        Name : {type : 'string',required : true},
        Type : {type : 'string',required : true},
        Body : {type : 'object'},
        OwnerID : {type : 'string'},
        Url : {type : 'string'},
        Method : {type : 'string'}
    })
}

export default Component