import SyDB from '../../../../../SyDB.js'

class Variable {
    
    static Model = SyDB.Model('Variables',{
        Key : {required : true,type : 'string'},
        Value : {required : true,type : 'string'},
    })
}

export default Variable